import { loadConfig } from "../src/config.js";
import { RuntimeTargetSlnStore } from "../src/registration/runtime-target-store.js";

function parseTargets(args: readonly string[]): readonly (readonly string[])[] {
  return args
    .flatMap((argument) => argument.split(","))
    .map((target) =>
      target.split("+").map((sln) => sln.trim()).filter(Boolean),
    )
    .filter((target) => target.length > 0);
}

function main(): void {
  const store = new RuntimeTargetSlnStore();
  const config = loadConfig(process.env);
  const requested = parseTargets(process.argv.slice(2));
  if (requested.length === 0) {
    console.info("Runtime registration targets", {
      targets: store.loadTargets(config.targetSlns).map((target) => target.slns),
    });
    return;
  }
  const targets = store.saveTargets(requested);
  console.info("Runtime registration targets updated.", {
    targets: targets.map((target) => target.slns),
  });
  console.info("A running AutoGrab process will use these targets immediately.");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown failure";
  console.error("Runtime target update failed.", { message });
  process.exitCode = 1;
}
