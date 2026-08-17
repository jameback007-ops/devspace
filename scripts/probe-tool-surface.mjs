import { probeToolSurface } from "../dist/tool-surface-deployment-cli.js";

await probeToolSurface(process.argv.slice(2));
