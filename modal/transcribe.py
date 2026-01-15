"""
Modal transcription endpoint for Podgest.

Deploy with: modal deploy transcribe.py
"""

import modal

# Define the image with faster-whisper and ffmpeg
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "faster-whisper==1.0.3",
        "requests",
    )
)

app = modal.App("podgest-transcribe", image=image)


@app.cls(
    gpu="A10G",
    timeout=1800,  # 30 min for long podcasts
    container_idle_timeout=300,  # Keep warm 5 min between jobs
    memory=8192,  # 8GB RAM
    retries=2,
)
class Transcriber:
    @modal.enter()
    def load_model(self):
        """Load Whisper model once per container."""
        from faster_whisper import WhisperModel
        
        # Use base model for balance of speed/accuracy
        self.model = WhisperModel("base", device="cuda", compute_type="float16")
        print("✅ Whisper model loaded")

    def _preprocess_audio(self, input_path: str, output_path: str) -> str:
        """Preprocess audio: mono, 16kHz, remove silence."""
        import subprocess
        try:
            cmd = [
                "ffmpeg", "-y", "-i", input_path,
                "-ac", "1",  # mono
                "-ar", "16000",  # 16kHz
                "-vn",  # no video
                "-af", "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-40dB",
                output_path
            ]
            subprocess.run(cmd, check=True, capture_output=True)
            return output_path
        except subprocess.CalledProcessError as e:
            print(f"⚠️ ffmpeg failed, using original: {e}")
            return input_path

    @modal.method()
    def transcribe(self, audio_url: str, webhook_url: str | None = None, job_id: str | None = None) -> dict:
        """
        Transcribe audio from URL.
        
        If webhook_url is provided, POSTs result there instead of returning.
        """
        import tempfile
        import os
        import requests
        
        input_path = None
        processed_path = None
        
        try:
            # Download audio
            print(f"📥 Downloading: {audio_url}")
            response = requests.get(audio_url, stream=True, timeout=300)
            response.raise_for_status()
            
            with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as f:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
                input_path = f.name
            
            print(f"✅ Downloaded to {input_path}")
            
            # Preprocess
            processed_path = tempfile.mktemp(suffix=".wav")
            audio_path = self._preprocess_audio(input_path, processed_path)
            
            # Transcribe
            print("🎤 Transcribing...")
            segments, info = self.model.transcribe(
                audio_path,
                word_timestamps=True,
                temperature=0.0,
            )
            
            # Collect segments
            segments_list = []
            full_text_parts = []
            
            for segment in segments:
                segments_list.append({
                    "start": segment.start,
                    "end": segment.end,
                    "text": segment.text.strip(),
                })
                full_text_parts.append(segment.text.strip())
            
            result = {
                "status": "completed",
                "job_id": job_id,
                "text": " ".join(full_text_parts),
                "segments": segments_list,
                "language": info.language,
                "duration": info.duration,
            }
            
            print(f"✅ Transcribed: {len(result['text'])} chars, {len(segments_list)} segments")
            
            # If webhook provided, POST result there
            if webhook_url:
                print(f"📤 Sending to webhook: {webhook_url}")
                requests.post(webhook_url, json=result, timeout=30)
                return {"status": "sent_to_webhook"}
            
            return result
            
        except Exception as e:
            error_result = {
                "status": "failed",
                "job_id": job_id,
                "error": str(e),
            }
            
            if webhook_url:
                requests.post(webhook_url, json=error_result, timeout=30)
                return {"status": "error_sent_to_webhook"}
            
            return error_result
            
        finally:
            # Cleanup temp files
            for path in [input_path, processed_path]:
                if path and os.path.exists(path):
                    try:
                        os.unlink(path)
                    except:
                        pass


# Simple function wrapper for direct calls
@app.function()
def transcribe_audio(audio_url: str, webhook_url: str | None = None, job_id: str | None = None) -> dict:
    """Convenience function to transcribe audio."""
    transcriber = Transcriber()
    return transcriber.transcribe.remote(audio_url, webhook_url, job_id)


@app.local_entrypoint()
def main():
    """Test the transcription endpoint."""
    print("Podgest transcription service ready!")
    print("Deploy with: modal deploy transcribe.py")
    print("Test with: modal run transcribe.py")
