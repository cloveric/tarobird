#!/usr/bin/env python3
"""Cold fallback with the same duration, chunking and memory rules as HTTP."""
import os
import sys
from server import load_model, validate_audio, transcribe_chunked, release_inference_cache

if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: transcribe.py <audio-file>")
    try:
        audio = os.path.abspath(sys.argv[1])
        validate_audio(audio)
        text, _pieces = transcribe_chunked(load_model(), audio)
        if not text.strip():
            sys.exit("No speech recognized")
        print(text)
    except Exception as error:
        sys.exit(f"Local ASR failed ({type(error).__name__}); check model, ffmpeg and audio duration")
    finally:
        release_inference_cache()
