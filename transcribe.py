#!/usr/bin/env python3
# Sarvam Batch transcription using official SDK
# Called by index.js via child_process

import sys
import json
import os
import tempfile

def main():
    audio_path = sys.argv[1]
    sarvam_key = sys.argv[2]
    language   = sys.argv[3] if len(sys.argv) > 3 else 'te-IN'

    from sarvamai import SarvamAI
    client = SarvamAI(api_subscription_key=sarvam_key)

    job = client.speech_to_text_job.create_job(
        model='saaras:v3',
        mode='transcribe',
        language_code=language,
        with_diarization=True,
        num_speakers=5
    )

    job.upload_files(file_paths=[audio_path])
    job.start()
    job.wait_until_complete()

    file_results = job.get_file_results()

    segments = []
    transcript = ''

    for f in file_results.get('successful', []):
        output = f.get('output', {})
        # diarized_transcript
        if output.get('diarized_transcript', {}).get('entries'):
            for e in output['diarized_transcript']['entries']:
                segments.append({
                    'start': e.get('start_time_seconds', 0),
                    'end':   e.get('end_time_seconds', 0),
                    'text':  e.get('transcript', ''),
                    'speaker': f"SPK{e.get('speaker_id','0')}"
                })
            transcript = output.get('transcript', '')
        elif output.get('transcript'):
            transcript = output['transcript']
            # fallback: split by sentences
            sents = [s.strip() for s in transcript.split('.') if s.strip()]
            dur = 10
            for i, text in enumerate(sents):
                segments.append({'start': i*dur, 'end': (i+1)*dur, 'text': text, 'speaker': 'SPK0'})

    print(json.dumps({'success': True, 'segments': segments, 'transcript': transcript}))

if __name__ == '__main__':
    main()
