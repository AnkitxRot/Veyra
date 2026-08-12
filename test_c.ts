import fs from 'node:fs';
import { runProject } from './backend/src/execution/pipeline.js';
import { resolveConfig } from './backend/src/config.js';
fs.mkdirSync('test_c_project', { recursive: true });
fs.writeFileSync('test_c_project/hello.c', '#include <stdio.h>\nint main() { printf("Hello C\\n"); return 0; }');
const cfg = resolveConfig();
runProject(cfg, process.cwd() + '/test_c_project', { language: 'c', activeFile: 'hello.c' }).then(console.log).catch(console.error);
