"""
Modal endpoints for Podgest.

- Transcription (Whisper)
- TTS (ElevenLabs)

Deploy with: modal deploy transcribe.py
"""

import modal

# Define the image with faster-whisper, ffmpeg, and CUDA
transcribe_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.0-cudnn8-runtime-ubuntu22.04",
        add_python="3.11"
    )
    .apt_install("ffmpeg")
    .pip_install(
        "faster-whisper==1.0.3",
        "requests",
        "fastapi",
    )
)

# Lighter image for TTS (no GPU needed)
tts_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "requests",
        "fastapi",
        "openai",
    )
)

# Test TTS image with Edge TTS (free Microsoft TTS)
test_tts_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "edge-tts",
        "requests",
        "fastapi",
    )
)

app = modal.App("podgest-transcribe")


@app.cls(
    image=transcribe_image,
    gpu="A10G",
    timeout=1800,  # 30 min for long podcasts
    scaledown_window=300,  # Keep warm 5 min between jobs
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
    def transcribe(self, audio_url: str, webhook_url: str | None = None, job_id: str | None = None, admin_key: str | None = None) -> dict:
        """
        Transcribe audio from URL.
        
        If webhook_url is provided, POSTs result there instead of returning.
        If admin_key is provided, includes it as X-Admin-Key header in webhook calls.
        """
        import tempfile
        import os
        import requests
        
        input_path = None
        processed_path = None
        
        try:
            # Download audio with browser-like headers
            print(f"📥 Downloading: {audio_url}")
            headers = {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "audio/mpeg,audio/*;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            }
            response = requests.get(audio_url, stream=True, timeout=300, headers=headers)
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
            
            # Collect segments (convert to plain Python types for serialization)
            segments_list = []
            full_text_parts = []
            
            for segment in segments:
                segments_list.append({
                    "start": float(segment.start),
                    "end": float(segment.end),
                    "text": str(segment.text.strip()),
                })
                full_text_parts.append(segment.text.strip())
            
            result = {
                "status": "completed",
                "job_id": job_id,
                "text": " ".join(full_text_parts),
                "segments": segments_list,
                "language": str(info.language),
                "duration": float(info.duration),
            }
            
            print(f"✅ Transcribed: {len(result['text'])} chars, {len(segments_list)} segments")
            
            # If webhook provided, POST result there
            if webhook_url:
                print(f"📤 Sending to webhook: {webhook_url}")
                webhook_headers = {"Content-Type": "application/json"}
                if admin_key:
                    webhook_headers["X-Admin-Key"] = admin_key
                requests.post(webhook_url, json=result, headers=webhook_headers, timeout=30)
                return {"status": "sent_to_webhook"}
            
            return result
            
        except Exception as e:
            import traceback
            print(f"❌ Error: {e}")
            print(traceback.format_exc())
            error_result = {
                "status": "failed",
                "job_id": job_id,
                "error": str(e),
                "traceback": traceback.format_exc(),
            }
            
            if webhook_url:
                webhook_headers = {"Content-Type": "application/json"}
                if admin_key:
                    webhook_headers["X-Admin-Key"] = admin_key
                requests.post(webhook_url, json=error_result, headers=webhook_headers, timeout=30)
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


# ============================================
# TTS (Text-to-Speech) with ElevenLabs
# ============================================

@app.cls(
    image=tts_image,
    timeout=600,  # 10 min for long scripts
    scaledown_window=60,
    memory=2048,
    retries=1,
)
class TextToSpeech:
    """Generate audio from text using ElevenLabs API."""
    
    # ElevenLabs has ~5000 char limit per request
    MAX_CHUNK_SIZE = 4500
    
    @modal.method()
    def generate(
        self,
        script: str,
        elevenlabs_api_key: str,
        voice_id: str = "cjVigY5qzO86Huf0OWal",  # Eric - professional
        supabase_url: str | None = None,
        supabase_key: str | None = None,
        digest_id: str | None = None,
        webhook_url: str | None = None,
        admin_key: str | None = None,
    ) -> dict:
        """
        Generate audio from script text.
        
        If supabase_url/key provided, uploads to Supabase Storage.
        If webhook_url provided, sends result there.
        
        Returns: { status, audio_url, duration_seconds, characters }
        """
        import requests
        import tempfile
        import subprocess
        import os
        import base64
        
        try:
            print(f"🎙️ Generating TTS for {len(script)} characters")
            
            # Remove [PAUSE] markers and split into chunks
            clean_script = script.replace("[PAUSE]", " ... ")
            chunks = self._chunk_text(clean_script)
            print(f"📦 Split into {len(chunks)} chunks")
            
            # Generate audio for each chunk
            audio_files = []
            total_chars = 0
            
            for i, chunk in enumerate(chunks):
                print(f"🔊 Generating chunk {i+1}/{len(chunks)} ({len(chunk)} chars)")
                audio_data = self._generate_chunk(chunk, voice_id, elevenlabs_api_key)
                
                if not audio_data:
                    raise Exception(f"Failed to generate audio for chunk {i+1}")
                
                # Save to temp file
                with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as f:
                    f.write(audio_data)
                    audio_files.append(f.name)
                
                total_chars += len(chunk)
            
            # Concatenate all audio files with ffmpeg
            print(f"🔗 Concatenating {len(audio_files)} audio files")
            output_path = tempfile.mktemp(suffix=".mp3")
            self._concat_audio(audio_files, output_path)
            
            # Get duration
            duration = self._get_duration(output_path)
            print(f"⏱️ Total duration: {duration:.1f}s")
            
            # Read final audio
            with open(output_path, "rb") as f:
                final_audio = f.read()
            
            result = {
                "status": "completed",
                "digest_id": digest_id,
                "duration_seconds": int(duration),
                "characters": total_chars,
            }
            
            # Upload to Supabase if credentials provided
            if supabase_url and supabase_key and digest_id:
                audio_path = f"{digest_id}/digest.mp3"
                upload_url = f"{supabase_url}/storage/v1/object/digests/{audio_path}"
                
                print(f"📤 Uploading to Supabase: {audio_path}")
                upload_response = requests.post(
                    upload_url,
                    headers={
                        "Authorization": f"Bearer {supabase_key}",
                        "Content-Type": "audio/mpeg",
                        "x-upsert": "true",
                    },
                    data=final_audio,
                    timeout=120,
                )
                
                if upload_response.ok:
                    result["audio_url"] = f"{supabase_url}/storage/v1/object/public/digests/{audio_path}"
                    print(f"✅ Uploaded: {result['audio_url']}")
                else:
                    print(f"❌ Upload failed: {upload_response.status_code} - {upload_response.text}")
                    result["upload_error"] = upload_response.text
            else:
                # Return base64 if no storage configured
                result["audio_base64"] = base64.b64encode(final_audio).decode()
            
            # Cleanup temp files
            for f in audio_files + [output_path]:
                if os.path.exists(f):
                    os.unlink(f)
            
            # Send to webhook if provided
            if webhook_url:
                print(f"📤 Sending to webhook: {webhook_url}")
                webhook_headers = {"Content-Type": "application/json"}
                if admin_key:
                    webhook_headers["X-Admin-Key"] = admin_key
                # Don't include base64 in webhook (too large)
                webhook_result = {k: v for k, v in result.items() if k != "audio_base64"}
                requests.post(webhook_url, json=webhook_result, headers=webhook_headers, timeout=30)
            
            return result
            
        except Exception as e:
            import traceback
            print(f"❌ TTS Error: {e}")
            print(traceback.format_exc())
            
            error_result = {
                "status": "failed",
                "digest_id": digest_id,
                "error": str(e),
            }
            
            if webhook_url:
                webhook_headers = {"Content-Type": "application/json"}
                if admin_key:
                    webhook_headers["X-Admin-Key"] = admin_key
                requests.post(webhook_url, json=error_result, headers=webhook_headers, timeout=30)
            
            return error_result
    
    def _chunk_text(self, text: str) -> list[str]:
        """Split text into chunks at paragraph boundaries."""
        paragraphs = text.split("\n\n")
        chunks = []
        current = ""
        
        for para in paragraphs:
            if len(current) + len(para) + 2 > self.MAX_CHUNK_SIZE:
                if current:
                    chunks.append(current.strip())
                current = para
            else:
                current += ("\n\n" if current else "") + para
        
        if current:
            chunks.append(current.strip())
        
        return chunks
    
    def _generate_chunk(self, text: str, voice_id: str, api_key: str) -> bytes | None:
        """Generate audio for a single chunk."""
        import requests
        
        response = requests.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
            headers={
                "xi-api-key": api_key,
                "Content-Type": "application/json",
            },
            json={
                "text": text,
                "model_id": "eleven_turbo_v2_5",
                "voice_settings": {
                    "stability": 0.75,
                    "similarity_boost": 0.8,
                },
            },
            timeout=120,
        )
        
        if response.ok:
            return response.content
        else:
            print(f"❌ ElevenLabs error: {response.status_code} - {response.text}")
            return None
    
    def _concat_audio(self, input_files: list[str], output_path: str):
        """Concatenate audio files using ffmpeg."""
        import subprocess
        import tempfile
        
        # Create concat file
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".txt") as f:
            for path in input_files:
                f.write(f"file '{path}'\n")
            concat_list = f.name
        
        try:
            subprocess.run([
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", concat_list, "-c", "copy", output_path
            ], check=True, capture_output=True)
        finally:
            import os
            os.unlink(concat_list)
    
    def _get_duration(self, audio_path: str) -> float:
        """Get audio duration in seconds."""
        import subprocess
        import json
        
        result = subprocess.run([
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", audio_path
        ], capture_output=True, text=True)
        
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return float(data.get("format", {}).get("duration", 0))
        return 0


# ============================================
# TTS with OpenAI (Primary - 10x cheaper than ElevenLabs)
# ============================================

@app.cls(
    image=tts_image,
    timeout=600,
    scaledown_window=60,
    memory=2048,
    retries=1,
)
class OpenAITTS:
    """Generate audio from text using OpenAI TTS API."""
    
    # OpenAI TTS has 4096 char limit per request
    MAX_CHUNK_SIZE = 4000
    
    @modal.method()
    def generate(
        self,
        script: str,
        openai_api_key: str,
        voice: str = "onyx",  # onyx is great for news/podcasts (deep, authoritative)
        model: str = "tts-1-hd",  # tts-1-hd for quality, tts-1 for speed/cost
        supabase_url: str | None = None,
        supabase_key: str | None = None,
        digest_id: str | None = None,
        webhook_url: str | None = None,
        admin_key: str | None = None,
    ) -> dict:
        """
        Generate audio from script text using OpenAI TTS.
        
        Voices: alloy, echo, fable, onyx, nova, shimmer
        Models: tts-1 (fast/cheap), tts-1-hd (quality)
        """
        import requests
        import tempfile
        import subprocess
        import os
        from openai import OpenAI
        
        try:
            print(f"🎙️ Generating OpenAI TTS for {len(script)} characters (voice={voice}, model={model})")
            
            client = OpenAI(api_key=openai_api_key)
            
            # Remove [PAUSE] markers and split into chunks
            clean_script = script.replace("[PAUSE]", " ... ")
            chunks = self._chunk_text(clean_script)
            print(f"📦 Split into {len(chunks)} chunks")
            
            # Generate audio for each chunk
            audio_files = []
            total_chars = 0
            
            for i, chunk in enumerate(chunks):
                print(f"🔊 Generating chunk {i+1}/{len(chunks)} ({len(chunk)} chars)")
                
                response = client.audio.speech.create(
                    model=model,
                    voice=voice,
                    input=chunk,
                    response_format="mp3",
                )
                
                # Save to temp file
                with tempfile.NamedTemporaryFile(delete=False, suffix=".mp3") as f:
                    for audio_chunk in response.iter_bytes():
                        f.write(audio_chunk)
                    audio_files.append(f.name)
                
                total_chars += len(chunk)
            
            # Concatenate all audio files with ffmpeg
            print(f"🔗 Concatenating {len(audio_files)} audio files")
            output_path = tempfile.mktemp(suffix=".mp3")
            self._concat_audio(audio_files, output_path)
            
            # Get duration
            duration = self._get_duration(output_path)
            print(f"⏱️ Total duration: {duration:.1f}s")
            
            # Read final audio
            with open(output_path, "rb") as f:
                final_audio = f.read()
            
            result = {
                "status": "completed",
                "digest_id": digest_id,
                "duration_seconds": int(duration),
                "characters": total_chars,
                "provider": "openai",
                "voice": voice,
                "model": model,
            }
            
            # Upload to Supabase if credentials provided
            if supabase_url and supabase_key and digest_id:
                audio_path = f"{digest_id}/digest.mp3"
                upload_url = f"{supabase_url}/storage/v1/object/digests/{audio_path}"
                
                print(f"📤 Uploading to Supabase: {audio_path}")
                upload_response = requests.post(
                    upload_url,
                    headers={
                        "Authorization": f"Bearer {supabase_key}",
                        "Content-Type": "audio/mpeg",
                        "x-upsert": "true",
                    },
                    data=final_audio,
                    timeout=120,
                )
                
                if upload_response.ok:
                    result["audio_url"] = f"{supabase_url}/storage/v1/object/public/digests/{audio_path}"
                    print(f"✅ Uploaded: {result['audio_url']}")
                else:
                    print(f"❌ Upload failed: {upload_response.status_code} - {upload_response.text}")
                    result["upload_error"] = upload_response.text
            
            # Cleanup temp files
            for f in audio_files + [output_path]:
                if os.path.exists(f):
                    os.unlink(f)
            
            # Send to webhook if provided
            if webhook_url:
                print(f"📤 Sending to webhook: {webhook_url}")
                webhook_headers = {"Content-Type": "application/json"}
                if admin_key:
                    webhook_headers["X-Admin-Key"] = admin_key
                requests.post(webhook_url, json=result, headers=webhook_headers, timeout=30)
            
            return result
            
        except Exception as e:
            import traceback
            print(f"❌ OpenAI TTS Error: {e}")
            print(traceback.format_exc())
            
            error_result = {
                "status": "failed",
                "digest_id": digest_id,
                "error": str(e),
                "provider": "openai",
            }
            
            if webhook_url:
                webhook_headers = {"Content-Type": "application/json"}
                if admin_key:
                    webhook_headers["X-Admin-Key"] = admin_key
                requests.post(webhook_url, json=error_result, headers=webhook_headers, timeout=30)
            
            return error_result
    
    def _chunk_text(self, text: str) -> list[str]:
        """Split text into chunks at sentence boundaries."""
        import re
        
        # Split by sentences
        sentences = re.split(r'(?<=[.!?])\s+', text)
        chunks = []
        current = ""
        
        for sentence in sentences:
            if len(current) + len(sentence) + 1 > self.MAX_CHUNK_SIZE:
                if current:
                    chunks.append(current.strip())
                current = sentence
            else:
                current += (" " if current else "") + sentence
        
        if current:
            chunks.append(current.strip())
        
        return chunks
    
    def _concat_audio(self, input_files: list[str], output_path: str):
        """Concatenate audio files using ffmpeg."""
        import subprocess
        import tempfile
        
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".txt") as f:
            for path in input_files:
                f.write(f"file '{path}'\n")
            concat_list = f.name
        
        try:
            subprocess.run([
                "ffmpeg", "-y", "-f", "concat", "-safe", "0",
                "-i", concat_list, "-c", "copy", output_path
            ], check=True, capture_output=True)
        finally:
            import os
            os.unlink(concat_list)
    
    def _get_duration(self, audio_path: str) -> float:
        """Get audio duration in seconds."""
        import subprocess
        import json
        
        result = subprocess.run([
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", audio_path
        ], capture_output=True, text=True)
        
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return float(data.get("format", {}).get("duration", 0))
        return 0


# OpenAI TTS Web endpoint (PRIMARY)
@app.function(image=tts_image)
@modal.fastapi_endpoint(method="POST")
def openai_tts_web(request: dict) -> dict:
    """
    HTTP endpoint for OpenAI TTS generation.
    
    Expected JSON body:
    {
        "script": "...",
        "openai_api_key": "...",
        "voice": "onyx" (optional - alloy, echo, fable, onyx, nova, shimmer),
        "model": "tts-1-hd" (optional - tts-1 or tts-1-hd),
        "supabase_url": "..." (optional),
        "supabase_key": "..." (optional),
        "digest_id": "..." (optional),
        "webhook_url": "..." (optional)
    }
    """
    script = request.get("script")
    api_key = request.get("openai_api_key")
    
    if not script:
        return {"error": "script is required"}
    if not api_key:
        return {"error": "openai_api_key is required"}
    
    tts = OpenAITTS()
    return tts.generate.remote(
        script=script,
        openai_api_key=api_key,
        voice=request.get("voice", "onyx"),
        model=request.get("model", "tts-1-hd"),
        supabase_url=request.get("supabase_url"),
        supabase_key=request.get("supabase_key"),
        digest_id=request.get("digest_id"),
        webhook_url=request.get("webhook_url"),
        admin_key=request.get("admin_key"),
    )


# ElevenLabs TTS Web endpoint (legacy)
@app.function(image=tts_image)
@modal.fastapi_endpoint(method="POST")
def tts_web(request: dict) -> dict:
    """
    HTTP endpoint for TTS generation.
    
    Expected JSON body:
    {
        "script": "...",
        "elevenlabs_api_key": "...",
        "voice_id": "..." (optional),
        "supabase_url": "..." (optional),
        "supabase_key": "..." (optional),
        "digest_id": "..." (optional),
        "webhook_url": "..." (optional)
    }
    """
    script = request.get("script")
    api_key = request.get("elevenlabs_api_key")
    
    if not script:
        return {"error": "script is required"}
    if not api_key:
        return {"error": "elevenlabs_api_key is required"}
    
    # Generate synchronously (Modal handles timeouts)
    tts = TextToSpeech()
    return tts.generate.remote(
        script=script,
        elevenlabs_api_key=api_key,
        voice_id=request.get("voice_id", "cjVigY5qzO86Huf0OWal"),
        supabase_url=request.get("supabase_url"),
        supabase_key=request.get("supabase_key"),
        digest_id=request.get("digest_id"),
        webhook_url=request.get("webhook_url"),
        admin_key=request.get("admin_key"),
    )


# ============================================
# TEST TTS (Free Edge TTS - for testing only)
# ============================================

@app.cls(
    image=test_tts_image,
    timeout=600,
    scaledown_window=60,
    memory=2048,
)
class TestTTS:
    """Generate audio using free Edge TTS (Microsoft) for testing."""
    
    @modal.method()
    def generate(
        self,
        script: str,
        voice: str = "en-US-GuyNeural",  # Good male news voice
        supabase_url: str | None = None,
        supabase_key: str | None = None,
        test_id: str | None = None,
    ) -> dict:
        """Generate test audio using Edge TTS (free)."""
        import asyncio
        import edge_tts
        import tempfile
        import os
        import requests
        import subprocess
        import json
        
        try:
            test_id = test_id or f"test-{int(__import__('time').time())}"
            print(f"🎙️ Generating test TTS for {len(script)} characters")
            
            # Clean script
            clean_script = script.replace("[PAUSE]", "...")
            
            # Generate with Edge TTS
            output_path = tempfile.mktemp(suffix=".mp3")
            
            async def generate_audio():
                communicate = edge_tts.Communicate(clean_script, voice)
                await communicate.save(output_path)
            
            asyncio.run(generate_audio())
            
            # Get duration
            duration = 0
            try:
                result = subprocess.run([
                    "ffprobe", "-v", "quiet", "-print_format", "json",
                    "-show_format", output_path
                ], capture_output=True, text=True)
                if result.returncode == 0:
                    data = json.loads(result.stdout)
                    duration = int(float(data.get("format", {}).get("duration", 0)))
            except:
                pass
            
            print(f"⏱️ Duration: {duration}s")
            
            # Read audio
            with open(output_path, "rb") as f:
                audio_data = f.read()
            
            result = {
                "status": "completed",
                "test_id": test_id,
                "duration_seconds": duration,
                "characters": len(clean_script),
                "voice": voice,
            }
            
            # Upload to test bucket if Supabase configured
            if supabase_url and supabase_key:
                audio_path = f"{test_id}/test-audio.mp3"
                upload_url = f"{supabase_url}/storage/v1/object/test-audio/{audio_path}"
                
                print(f"📤 Uploading to test bucket: {audio_path}")
                upload_response = requests.post(
                    upload_url,
                    headers={
                        "Authorization": f"Bearer {supabase_key}",
                        "Content-Type": "audio/mpeg",
                        "x-upsert": "true",
                    },
                    data=audio_data,
                    timeout=120,
                )
                
                if upload_response.ok:
                    result["audio_url"] = f"{supabase_url}/storage/v1/object/public/test-audio/{audio_path}"
                    print(f"✅ Uploaded: {result['audio_url']}")
                else:
                    print(f"❌ Upload failed: {upload_response.status_code} - {upload_response.text}")
                    result["upload_error"] = upload_response.text
            
            # Cleanup
            if os.path.exists(output_path):
                os.unlink(output_path)
            
            return result
            
        except Exception as e:
            import traceback
            print(f"❌ Test TTS Error: {e}")
            print(traceback.format_exc())
            return {
                "status": "failed",
                "test_id": test_id,
                "error": str(e),
            }


# Test TTS Web endpoint (free, for testing only)
@app.function(image=test_tts_image)
@modal.fastapi_endpoint(method="POST")
def test_tts_web(request: dict) -> dict:
    """
    FREE TTS endpoint for testing (uses Microsoft Edge TTS).
    
    Expected JSON body:
    {
        "script": "...",
        "voice": "en-US-GuyNeural" (optional),
        "supabase_url": "..." (optional),
        "supabase_key": "..." (optional),
        "test_id": "..." (optional)
    }
    """
    script = request.get("script")
    
    if not script:
        return {"error": "script is required"}
    
    tts = TestTTS()
    return tts.generate.remote(
        script=script,
        voice=request.get("voice", "en-US-GuyNeural"),
        supabase_url=request.get("supabase_url"),
        supabase_key=request.get("supabase_key"),
        test_id=request.get("test_id"),
    )


# Simple function wrapper for direct calls
@app.function(image=transcribe_image)
def transcribe_audio(audio_url: str, webhook_url: str | None = None, job_id: str | None = None) -> dict:
    """Convenience function to transcribe audio."""
    transcriber = Transcriber()
    return transcriber.transcribe.remote(audio_url, webhook_url, job_id)


# Web endpoint for HTTP triggers from Inngest
@app.function(image=transcribe_image)
@modal.fastapi_endpoint(method="POST")
def transcribe_web(request: dict) -> dict:
    """
    HTTP endpoint for triggering transcription.
    
    Expected JSON body:
    {
        "audio_url": "https://...",
        "webhook_url": "https://...",
        "job_id": "..."
    }
    """
    audio_url = request.get("audio_url")
    webhook_url = request.get("webhook_url")
    job_id = request.get("job_id")
    
    if not audio_url:
        return {"error": "audio_url is required"}
    
    admin_key = request.get("admin_key")
    
    # Spawn async transcription (don't wait for result)
    transcriber = Transcriber()
    transcriber.transcribe.spawn(audio_url, webhook_url, job_id, admin_key)
    
    return {
        "status": "accepted",
        "message": "Transcription job started",
        "job_id": job_id,
    }


@app.local_entrypoint()
def main(audio_url: str = "", output_file: str = ""):
    """Test the transcription endpoint."""
    if not audio_url:
        print("Podgest transcription service ready!")
        print("Deploy with: modal deploy transcribe.py")
        print("Test with: modal run transcribe.py --audio-url <URL>")
        print("Save to file: modal run transcribe.py --audio-url <URL> --output-file transcript.json")
        return
    
    print(f"🚀 Starting transcription of: {audio_url}")
    transcriber = Transcriber()
    result = transcriber.transcribe.remote(audio_url)
    
    print("\n" + "=" * 60)
    print(f"Status: {result.get('status')}")
    if result.get('error'):
        print(f"Error: {result.get('error')}")
    print(f"Language: {result.get('language')}")
    print(f"Duration: {result.get('duration', 0):.1f}s")
    print(f"Segments: {len(result.get('segments', []))}")
    print(f"Text length: {len(result.get('text', ''))} chars")
    print("=" * 60)
    
    if output_file and result.get('status') == 'completed':
        import json
        with open(output_file, 'w') as f:
            json.dump(result, f, indent=2)
        print(f"\n💾 Saved to: {output_file}")
    elif result.get('status') == 'completed':
        print("\n📝 First 1000 chars of transcript:")
        print(result.get('text', '')[:1000])
        print("..." if len(result.get('text', '')) > 1000 else "")
