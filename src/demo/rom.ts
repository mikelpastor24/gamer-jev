/** Original, synthetic ROM: a scrolling checkerboard with a 440 Hz test tone.
 * No boot logo or third-party game assets are included. The emulator skips boot.
 */
export const DEMO_READY_ADDRESS = 0xc000;

export function createDemoRom(): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom.set([0xc3, 0x50, 0x01], 0x100); // JP $0150
  rom.set(Buffer.from("GAMER JEV DEMO", "ascii"), 0x134);
  rom[0x147] = 0; // ROM-only cartridge
  rom[0x148] = 0; // 32 KiB
  rom[0x149] = 0; // No external RAM

  const code: number[] = [];
  const emit = (...bytes: number[]) => { code.push(...bytes); };
  const address = () => 0x150 + code.length;
  const jump = (opcode: number, target: number) => emit(opcode, target & 0xff, target >> 8);

  emit(0xf3, 0x31, 0xfe, 0xff); // DI; LD SP,$FFFE
  emit(0xaf, 0xea, DEMO_READY_ADDRESS & 0xff, DEMO_READY_ADDRESS >> 8); // Clear the demo's readiness flag in work RAM.
  // Reset the APU and play a steady square wave on pulse channel 1, in stereo.
  for (const [register, value] of [[0x26, 0x00], [0x26, 0x80], [0x24, 0x77], [0x25, 0x11],
    [0x10, 0x00], [0x11, 0x80], [0x12, 0xf0], [0x13, 0xd6], [0x14, 0x86]]) {
    emit(0x3e, value!, 0xe0, register!);
  }
  const waitForVBlank = address();
  emit(0xf0, 0x44, 0xfe, 0x90); // LDH A,[$FF44]; CP 144
  jump(0xda, waitForVBlank); // JP C,waitForVBlank
  emit(0xaf, 0xe0, 0x40); // Disable LCD
  emit(0x21, 0x00, 0x80, 0x06, 0x08, 0x16, 0xaa); // HL=$8000, B=8, D=$AA
  const tileLoop = address();
  emit(0x7a, 0x22, 0xaf, 0x22, 0x7a, 0x2f, 0x57, 0x05); // Alternate checkerboard rows
  jump(0xc2, tileLoop);
  emit(0x21, 0x00, 0x98, 0x01, 0x00, 0x04); // HL=$9800, BC=1024
  const mapLoop = address();
  emit(0xaf, 0x22, 0x0b, 0x78, 0xb1);
  jump(0xc2, mapLoop);
  emit(0xaf, 0xe0, 0x42, 0xe0, 0x43); // Scroll origin
  emit(0x3e, 0xe4, 0xe0, 0x47); // Grayscale palette
  emit(0x3e, 0x91, 0xe0, 0x40); // Enable LCD and background
  emit(0x3e, 0x01, 0xea, DEMO_READY_ADDRESS & 0xff, DEMO_READY_ADDRESS >> 8); // Mark gameplay ready.

  const loop = address();
  emit(0xf0, 0x44, 0xfe, 0x90);
  jump(0xda, loop);
  emit(0x3e, 0x20, 0xe0, 0x00, 0xf0, 0x00, 0xf0, 0x00, 0x47); // Read directions into B
  for (const [bit, register, instruction] of [[0, 0x43, 0x3c], [1, 0x43, 0x3d], [2, 0x42, 0x3d], [3, 0x42, 0x3c]]) {
    emit(0xcb, 0x40 + bit! * 8, 0x20, 0x05, 0xf0, register!, instruction!, 0xe0, register!);
  }
  const waitForNextFrame = address();
  emit(0xf0, 0x44, 0xfe, 0x90);
  jump(0xd2, waitForNextFrame);
  jump(0xc3, loop);
  rom.set(code, 0x150);
  let checksum = 0;
  for (let index = 0x134; index <= 0x14c; index++) checksum = (checksum - rom[index]! - 1) & 0xff;
  rom[0x14d] = checksum;
  const globalChecksum = rom.reduce((sum, byte) => (sum + byte) & 0xffff, 0);
  rom[0x14e] = globalChecksum >> 8;
  rom[0x14f] = globalChecksum & 0xff;
  return rom;
}
