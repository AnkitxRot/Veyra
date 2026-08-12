const fs = require('fs');
fs.mkdirSync('test_c_project', { recursive: true });
fs.writeFileSync('test_c_project/hello.c', '#include <stdio.h>\nint main() { printf("Hello C\\n"); return 0; }');
const { runProject } = require('./backend/dist/execution/pipeline.js');
const { getAppConfig } = require('./backend/dist/config.js');
const cfg = getAppConfig();
runProject(cfg, process.cwd() + '/test_c_project', { language: 'c', activeFile: 'hello.c' }).then(console.log).catch(console.error);
