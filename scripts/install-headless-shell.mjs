#!/usr/bin/env node
import { installShell, VERSION } from './headless/shell.mjs';
try { console.log(`headless shell ${VERSION}: ${await installShell()}`); }
catch (error) { console.error(error.message); process.exitCode = 1; }
