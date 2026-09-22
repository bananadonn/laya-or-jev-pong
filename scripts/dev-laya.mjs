// Cross-platform launcher for the local Laya server's venv, so `npm run
// dev`/`dev:laya` doesn't depend on the venv being activated in whatever
// shell npm happens to run scripts through (cmd.exe, PowerShell, bash all
// behave differently here).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverDir = path.join(repoRoot, "server");
const venvPython =
  process.platform === "win32"
    ? path.join(serverDir, ".venv", "Scripts", "python.exe")
    : path.join(serverDir, ".venv", "bin", "python");

if (!existsSync(venvPython)) {
  console.error(
    `Laya venv not found at ${venvPython}.\n` +
      `Run: python -m venv server/.venv && ` +
      `${process.platform === "win32" ? "server\\.venv\\Scripts\\pip" : "server/.venv/bin/pip"} install -r server/requirements.txt\n` +
      `(see docs/INTEGRATION.md)`,
  );
  process.exit(1);
}

const port = process.env.LAYA_PORT || "8787";
const child = spawn(venvPython, ["-m", "uvicorn", "laya_server:app", "--port", port, "--reload"], {
  cwd: serverDir,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
