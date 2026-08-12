const { spawn, execSync } = require('child_process');
try { execSync('docker rm -f ide-test', {stdio:'ignore'}); } catch {}
execSync('docker run -d --name ide-test cloudeeeide-runner:latest sleep infinity');
const child = spawn('docker', ['exec', '-i', 'ide-test', 'python3', '-c', 'name = input(); print(f"Hello, {name} from Python!")'], { stdio: ['pipe', 'pipe', 'pipe'] });
child.stdout.on('data', d => console.log('OUT:', d.toString()));
child.stderr.on('data', d => console.log('ERR:', d.toString()));
child.on('close', code => { console.log('EXIT:', code); execSync('docker rm -f ide-test'); });
setTimeout(() => { child.stdin.write('Alice\n'); }, 1000);
