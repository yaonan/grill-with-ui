#!/usr/bin/env node
// The program `serve --open-command` runs in place of the system browser opener:
//   node server.mjs serve --session <dir> --open-command <this file>
// serve calls it as `hub-open.mjs <session-url>`. It makes sure the hub is running and has it
// open that session as a tab; a browser window opens only when no hub page is open yet.
import { cmdOpen } from "./hub.mjs";

await cmdOpen(process.argv[2]);
