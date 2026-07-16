/** Familiar state: idle, running, error, celebrate */
export type FamiliarState = "idle" | "running" | "error" | "celebrate";

/** Animation frame selection based on state and tick */
export function familiarFrame(state: FamiliarState, tick: number): string {
  switch (state) {
    case "idle": {
      const blinkCycle = 5;
      const frame = tick % (blinkCycle * 2);
      return frame < blinkCycle ? "(o.o)" : "(-.-)";
    }
    case "running":
      return ["(o.o)", "(o_o)", "(o.o)", "(O_O)"][tick % 4]!;
    case "error":
      return "(x.x)";
    case "celebrate":
      return "\\(^o^)/";
  }
}
