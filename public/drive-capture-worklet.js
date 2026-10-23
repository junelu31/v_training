class DriveCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const channels = inputs[0] || [];
    let length = 0;
    for (const channel of channels) if (channel && channel.length > length) length = channel.length;
    if (!length) return true;
    const mix = new Float32Array(length);
    let used = 0;
    for (const channel of channels) {
      if (!channel || !channel.length) continue;
      used += 1;
      const n = Math.min(length, channel.length);
      for (let i = 0; i < n; i++) mix[i] += channel[i];
    }
    if (used > 1) {
      const scale = 1 / used;
      for (let i = 0; i < length; i++) mix[i] *= scale;
    }
    const output = outputs[0] && outputs[0][0];
    if (output && output.length) {
      output.fill(0);
      output[0] = 1e-4;
    }
    this.port.postMessage(mix);
    return true;
  }
}

registerProcessor('drive-capture', DriveCaptureProcessor);
