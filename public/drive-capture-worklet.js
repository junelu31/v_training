class DriveCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      // Copy before postMessage. Safari reuses the audio-thread buffer, so a view of it arrives empty.
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy);
    }
    return true;
  }
}

registerProcessor('drive-capture', DriveCaptureProcessor);
