#!/usr/bin/env python3
import sys, json, os, tempfile
 
def main():
    audio_path = sys.argv[1]
    sarvam_key = sys.argv[2]
    language   = sys.argv[3] if len(sys.argv) > 3 else 'te-IN'
 
    from sarvamai import SarvamAI
    client = SarvamAI(api_subscription_key=sarvam_key)
 
    print(f"Creating job for {audio_path}", file=sys.stderr)
    job = client.speech_to_text_job.create_job(
        model='saaras:v3',
        mode='transcribe',
        language_code=language,
        with_diarization=True,
        num_speakers=5
    )
    print(f"Job created: {job}", file=sys.stderr)
 
    job.upload_files(file_paths=[audio_path])
    print("File uploaded, starting...", file=sys.stderr)
    job.start()
 
    print("Waiting for completion...", file=sys.stderr)
    job.wait_until_complete()
 
    # Download outputs to temp dir
    out_dir = tempfile.mkdtemp()
    job.download_outputs(output_dir=out_dir)
    print(f"Outputs downloaded to {out_dir}", file=sys.stderr)
 
    # Find JSON output file
    segments = []
    transcript = ''
 
    for fname in os.listdir(out_dir):
        fpath = os.path.join(out_dir, fname)
        print(f"Output file: {fname}", file=sys.stderr)
        if fname.endswith('.json'):
            with open(fpath) as f:
                data = json.load(f)
            print(f"JSON keys: {list(data.keys())}", file=sys.stderr)
 
            transcript = data.get('transcript', '')
 
            # diarized_transcript
            dt = data.get('diarized_transcript', {})
            entries = dt.get('entries', []) if isinstance(dt, dict) else []
            if entries:
                for e in entries:
                    segments.append({
                        'start':   e.get('start_time_seconds', 0),
                        'end':     e.get('end_time_seconds', 0),
                        'text':    e.get('transcript', ''),
                        'speaker': f"SPK{e.get('speaker_id','0')}"
                    })
                print(f"Diarized segments: {len(segments)}", file=sys.stderr)
            elif data.get('timestamps', {}).get('words'):
                words  = data['timestamps']['words']
                starts = data['timestamps'].get('start_time_seconds', [])
                ends   = data['timestamps'].get('end_time_seconds', [])
                seg, sw, se = [], None, None
                for i, w in enumerate(words):
                    if sw is None: sw = starts[i] if i < len(starts) else 0
                    se = ends[i] if i < len(ends) else 0
                    seg.append(w)
                    if len(seg) >= 10 or i == len(words)-1:
                        segments.append({'start':sw,'end':se,'text':' '.join(seg),'speaker':'SPK0'})
                        seg, sw, se = [], None, None
                print(f"Timestamp segments: {len(segments)}", file=sys.stderr)
            elif transcript:
                sents = [s.strip() for s in transcript.replace('।','.').split('.') if s.strip()]
                for i, txt in enumerate(sents):
                    segments.append({'start':i*8,'end':(i+1)*8,'text':txt,'speaker':'SPK0'})
                print(f"Fallback segments: {len(segments)}", file=sys.stderr)
 
    # cleanup
    import shutil
    shutil.rmtree(out_dir, ignore_errors=True)
 
    print(json.dumps({'success': True, 'segments': segments, 'transcript': transcript}))
 
if __name__ == '__main__':
    main()
 
