"""Bounded, local Chinese speech recognition. Audio is read from stdin, never saved."""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys


def fail(code):
    print(json.dumps({"error": code}), flush=True)
    raise SystemExit(1)


def recognize(directory, samples):
    """SenseVoice ONNX inference with its published fbank/LFR/CMVN settings.

    Matches the official FunASR SenseVoice frontend and CTC decoder while
    avoiding the training framework's torch dependency on the small CPU host.
    """
    import numpy as np
    import yaml
    import kaldi_native_fbank as knf
    import onnxruntime as ort
    import sentencepiece as spm
    config = yaml.safe_load((directory / "config.yaml").read_text())["frontend_conf"]
    options = knf.FbankOptions()
    options.frame_opts.samp_freq = config["fs"]
    options.frame_opts.dither = config.get("dither", 0)
    options.frame_opts.window_type = config["window"]
    options.frame_opts.frame_length_ms = config["frame_length"]
    options.frame_opts.frame_shift_ms = config["frame_shift"]
    options.frame_opts.snip_edges = True
    options.mel_opts.num_bins = config["n_mels"]
    options.energy_floor = 0
    bank = knf.OnlineFbank(options)
    bank.accept_waveform(16000, (samples * 32768).tolist())
    features = np.asarray([bank.get_frame(i) for i in range(bank.num_frames_ready)], dtype=np.float32)
    if not len(features):
        fail("NO_SPEECH")
    window, stride = config["lfr_m"], config["lfr_n"]
    offsets = np.arange(0, len(features), stride)
    padded = np.pad(features, (((window - 1) // 2, window), (0, 0)), mode="edge")
    stacked = np.concatenate([padded[offsets + i] for i in range(window)], axis=1)
    cmvn = (directory / "am.mvn").read_text()
    shift = np.fromstring(re.search(r"<AddShift>.*?\[([^\]]+)\]", cmvn, re.S)[1], sep=" ")
    scale = np.fromstring(re.search(r"<Rescale>.*?\[([^\]]+)\]", cmvn, re.S)[1], sep=" ")
    features = ((stacked + shift) * scale).astype(np.float32)[None, :, :]
    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = 2
    session_options.inter_op_num_threads = 1
    session_options.enable_cpu_mem_arena = False
    session_options.log_severity_level = 3
    model = ort.InferenceSession(str(directory / "model_quant.onnx"), sess_options=session_options, providers=["CPUExecutionProvider"])
    values = [features, np.array([features.shape[1]], dtype=np.int32), np.array([0], dtype=np.int32), np.array([14], dtype=np.int32)]
    logits, lengths = model.run(None, {item.name: value for item, value in zip(model.get_inputs(), values)})
    sequence = np.argmax(logits[0, :int(lengths[0])], axis=-1)
    sequence = sequence[np.r_[True, sequence[1:] != sequence[:-1]]]
    tokens = sequence[sequence != 0].tolist()
    tokenizer = spm.SentencePieceProcessor(model_file=str(directory / "chn_jpn_yue_eng_ko_spectok.bpe.model"))
    return re.sub(r"<\|[^|]*\|>", "", tokenizer.decode(tokens)).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--format", choices=["wav", "mp3", "mov", "aac", "ogg", "matroska"], required=True)
    args = parser.parse_args()
    source = sys.stdin.buffer.read(6 * 1024 * 1024 + 1)
    if not source or len(source) > 6 * 1024 * 1024:
        fail("DECODE")
    try:
        # A seekable anonymous memory file also handles phone M4A files whose
        # metadata comes after the audio. No uploaded file is saved to disk.
        descriptor = os.memfd_create("warehouse-voice", os.MFD_CLOEXEC)
        try:
            os.write(descriptor, source)
            os.lseek(descriptor, 0, os.SEEK_SET)
            decoded = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-max_alloc", "67108864",
                "-protocol_whitelist", "file,pipe", "-threads", "2", "-f", args.format, "-i", f"/proc/self/fd/{descriptor}",
                "-t", "61", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000",
                "-threads", "2", "-f", "s16le", "pipe:1"
            ], pass_fds=(descriptor,), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
        finally:
            os.close(descriptor)
    except (subprocess.SubprocessError, OSError):
        fail("DECODE")
    seconds = len(decoded.stdout) / 32000
    if seconds > 60.5:
        fail("TOO_LONG")
    if seconds < 0.25:
        fail("TOO_SHORT")
    import numpy as np
    samples = np.frombuffer(decoded.stdout, dtype="<i2").astype(np.float32) / 32768
    if float(np.max(np.abs(samples))) < 0.003:
        fail("NO_SPEECH")
    directory = pathlib.Path(args.model_dir)
    text = recognize(directory, samples)
    if not text:
        fail("NO_SPEECH")
    print(json.dumps({"text": text, "seconds": round(seconds, 2)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        fail("INTERNAL")
