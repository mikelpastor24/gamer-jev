import type { Emulator, EmulatorDescriptor } from "../core/emulator.js";
import { GameBoyEmulator, GAME_BOY_DESCRIPTOR } from "./game-boy/game-boy-emulator.js";

export interface EmulatorRegistration {
  readonly descriptor: EmulatorDescriptor;
  readonly create: (rom: Uint8Array) => Emulator | Promise<Emulator>;
}

export class EmulatorRegistry {
  private readonly registrations = new Map<string, EmulatorRegistration>();

  register(registration: EmulatorRegistration): void {
    const id = registration.descriptor.consoleId;
    if (!id || this.registrations.has(id)) throw new Error(`Console is already registered or has an invalid ID: ${id}.`);
    this.registrations.set(id, registration);
  }

  list(): readonly EmulatorDescriptor[] {
    return Array.from(this.registrations.values(), (entry) => entry.descriptor);
  }

  async create(consoleId: string, rom: Uint8Array): Promise<Emulator> {
    const registration = this.registrations.get(consoleId);
    if (!registration) throw new Error(`Unsupported console: ${consoleId}. Available: ${this.list().map((item) => item.consoleId).join(", ")}.`);
    return registration.create(rom);
  }
}

export function createDefaultRegistry(): EmulatorRegistry {
  const registry = new EmulatorRegistry();
  registry.register({ descriptor: GAME_BOY_DESCRIPTOR, create: (rom) => new GameBoyEmulator(rom) });
  return registry;
}
