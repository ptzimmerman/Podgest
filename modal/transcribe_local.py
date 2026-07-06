"""
One-off local-file transcription using the same Modal faster-whisper pipeline.

Unlike transcribe.py (which downloads from a URL for the podcast pipeline),
this reads a local audio file, ships the bytes to a Modal GPU worker, and
prints/saves the transcript. Nothing is uploaded to public storage.

Usage:
    modal run transcribe_local.py --audio-file "/path/to/file.m4a" --output-file out.txt
"""

import modal

transcribe_image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.0-cudnn8-runtime-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("ffmpeg")
    .pip_install(
        "faster-whisper==1.0.3",
        "requests",
    )
)

app = modal.App("podgest-transcribe-local")


@app.function(image=transcribe_image, gpu="A10G", timeout=1800, memory=8192)
def transcribe_bytes(audio_bytes: bytes, suffix: str = ".m4a", model_size: str = "small") -> dict:
    import tempfile
    import os
    import subprocess
    from faster_whisper import WhisperModel

    input_path = None
    processed_path = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
            f.write(audio_bytes)
            input_path = f.name

        # Preprocess: mono, 16kHz (same as prod, minus silence trim for a meeting)
        processed_path = tempfile.mktemp(suffix=".wav")
        try:
            subprocess.run(
                [
                    "ffmpeg", "-y", "-i", input_path,
                    "-ac", "1", "-ar", "16000", "-vn",
                    processed_path,
                ],
                check=True, capture_output=True,
            )
            audio_path = processed_path
        except subprocess.CalledProcessError as e:
            print(f"ffmpeg failed, using original: {e}")
            audio_path = input_path

        model = WhisperModel(model_size, device="cuda", compute_type="float16")
        print("Whisper model loaded, transcribing...")

        segments, info = model.transcribe(
            audio_path,
            word_timestamps=True,
            temperature=0.0,
            vad_filter=True,
        )

        segments_list = []
        full_text_parts = []
        for seg in segments:
            segments_list.append({
                "start": float(seg.start),
                "end": float(seg.end),
                "text": str(seg.text.strip()),
            })
            full_text_parts.append(seg.text.strip())

        return {
            "status": "completed",
            "text": " ".join(full_text_parts),
            "segments": segments_list,
            "language": str(info.language),
            "duration": float(info.duration),
        }
    finally:
        for p in [input_path, processed_path]:
            if p and os.path.exists(p):
                os.unlink(p)


def _format_timestamp(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


@app.local_entrypoint()
def main(audio_file: str = "", output_file: str = "", model_size: str = "small"):
    import os

    if not audio_file:
        print("Usage: modal run transcribe_local.py --audio-file <path> [--output-file out.txt]")
        return

    with open(audio_file, "rb") as f:
        audio_bytes = f.read()

    suffix = os.path.splitext(audio_file)[1] or ".m4a"
    print(f"Uploading {len(audio_bytes) / 1e6:.1f} MB and transcribing on Modal GPU...")

    result = transcribe_bytes.remote(audio_bytes, suffix=suffix, model_size=model_size)

    print("\n" + "=" * 60)
    print(f"Status: {result.get('status')}")
    print(f"Language: {result.get('language')}")
    print(f"Duration: {result.get('duration', 0):.1f}s")
    print(f"Segments: {len(result.get('segments', []))}")
    print(f"Text length: {len(result.get('text', ''))} chars")
    print("=" * 60)

    if result.get("status") != "completed":
        print("Transcription failed.")
        print(result)
        return

    # Build a timestamped transcript
    lines = []
    for seg in result.get("segments", []):
        lines.append(f"[{_format_timestamp(seg['start'])}] {seg['text']}")
    timestamped = "\n".join(lines)

    if output_file:
        with open(output_file, "w") as f:
            f.write(result.get("text", ""))
        ts_path = os.path.splitext(output_file)[0] + "_timestamped.txt"
        with open(ts_path, "w") as f:
            f.write(timestamped)
        print(f"\nSaved plain transcript to: {output_file}")
        print(f"Saved timestamped transcript to: {ts_path}")
    else:
        print("\nTranscript:\n")
        print(result.get("text", ""))
