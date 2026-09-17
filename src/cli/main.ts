import { buildProgram } from "./program.js";

await buildProgram().parseAsync(process.argv);
