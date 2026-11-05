# Synthesises Wispr Guru's alert sounds from scratch (all original, no samples):
#   meow.wav   a cartoon cat "mrr-ow" (the default)
#   metal.wav  a two-second original power-chord sting with a kick
#   pspsps.wav three soft whispered "psst" bursts
#   boop.wav   a gentle two-note chime
# Run: python3 tools/make-sounds.py  (needs numpy + scipy)
import numpy as np
from scipy.signal import butter, lfilter
from scipy.io import wavfile
import os
SR = 44100
out = os.path.join(os.path.dirname(__file__), '..', 'sounds')

def env(n, a=0.01, r=0.1):
    e = np.ones(n); A = int(a * SR); R = int(r * SR)
    e[:A] = np.linspace(0, 1, A); e[-R:] = np.linspace(1, 0, R); return e

def bp(x, lo, hi):
    b, a = butter(2, [lo / (SR / 2), hi / (SR / 2)], 'band'); return lfilter(b, a, x)

def save(name, x):
    x = x / (np.max(np.abs(x)) + 1e-9) * 0.85
    wavfile.write(os.path.join(out, name), SR, (x * 32767).astype(np.int16))

def formant_voice(f0, f1, f2, dur):
    n = int(dur * SR); t = np.arange(n) / SR
    f0 = np.interp(t, np.linspace(0, dur, len(f0)), f0)
    ph = 2 * np.pi * np.cumsum(f0 * (1 + 0.012 * np.sin(2 * np.pi * 6 * t))) / SR
    src = sum(np.sin(k * ph) / k for k in range(1, 30))  # bright glottal-ish source
    y = np.zeros(n); blk = 512
    F1 = np.interp(t, np.linspace(0, dur, len(f1)), f1); F2 = np.interp(t, np.linspace(0, dur, len(f2)), f2)
    for i in range(0, n, blk):  # time-varying formants, block by block
        s = src[max(0, i - 2048):i + blk]
        a = bp(s, F1[i] * 0.8, F1[i] * 1.25) + 0.7 * bp(s, F2[i] * 0.85, F2[i] * 1.18)
        y[i:i + blk] = a[-len(src[i:i + blk]):]
    return y

# meow: "m" (closed, low F1) → "e" (open, high F2) → "ow" (rounded, low F2); pitch arcs up then down
meow = formant_voice([520, 700, 880, 820, 600, 430], [300, 650, 900, 800, 600, 420], [1400, 2300, 2600, 1800, 1100, 800], 0.9)
meow *= env(len(meow), 0.04, 0.25)
save('meow.wav', meow)

# metal: palm-muted E5 chugs into a ringing E5–G5 chord, hard-clipped, with a kick on each hit (original riff)
def chord(freqs, dur, mute=False):
    n = int(dur * SR); t = np.arange(n) / SR
    x = sum(2 * ((f * t) % 1) - 1 for f in freqs) + sum(2 * ((f * 1.003 * t) % 1) - 1 for f in freqs)
    x = np.tanh(6 * x)
    x = bp(x, 80, 3500 if not mute else 900)
    return x * (np.exp(-t * (14 if mute else 2.2)))
def kick(dur=0.25):
    n = int(dur * SR); t = np.arange(n) / SR
    return np.sin(2 * np.pi * (50 + 120 * np.exp(-t * 30)) * t) * np.exp(-t * 12)
E, B, G, D = 82.4, 123.5, 98.0, 146.8
seq = []
for d in [0.13, 0.13, 0.13, 0.26]:
    c = chord([E, B], d, mute=True); k = kick(d); seq.append(c * 0.7 + k[:len(c)] * 0.9)
for f in [[G, D], [E * 2 ** (3 / 12) * 1, E * 2 ** (10 / 12)]]:
    c = chord(f, 0.18, mute=True); seq.append(c * 0.7 + kick(0.18) * 0.9)
c = chord([E, B, E * 2], 1.1); k = np.pad(kick(), (0, len(c) - len(kick()))); seq.append(c + k)
metal = np.concatenate(seq)
save('metal.wav', metal)

# pspsps: three bursts of shaped noise, sibilant band
rng = np.random.default_rng(7)
parts = []
for _ in range(3):
    n = int(0.12 * SR); burst = bp(rng.standard_normal(n), 3500, 9000) * env(n, 0.01, 0.07)
    parts += [burst, np.zeros(int(0.07 * SR))]
save('pspsps.wav', np.concatenate(parts))

# boop: soft two-note chime
def tone(f, d):
    n = int(d * SR); t = np.arange(n) / SR
    return (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)) * np.exp(-t * 6)
save('boop.wav', np.concatenate([tone(880, 0.18), tone(1318.5, 0.5)]))
print('ok')
