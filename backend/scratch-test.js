import WebSocket from 'ws';

async function request(method, path, body, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  
  const res = await fetch(`http://localhost:3000${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }
  return res.status === 204 ? {} : res.json();
}

async function run() {
  try {
    // 1. Auth & Project Setup
    const userStr = `testuser_${Date.now()}`;
    const reg = await request('POST', '/api/auth/register', { username: userStr, password: 'password123' });
    const token = reg.token;
    
    const projRes = await request('POST', '/api/projects', { name: 'test-proj' }, token);
    const projectId = projRes.project.id;
    console.log(`Created project ${projectId} with token ${token.slice(0, 10)}...`);

    // 2. Python Test - Streaming and Output
    const pyCode = `
import time
import sys

print("output A")
sys.stdout.flush()
time.sleep(0.5)

print("output B", file=sys.stderr)
sys.stderr.flush()
time.sleep(0.5)

user_in = input("Enter something: ")
print(f"You entered: {user_in}")
`;
    await request('POST', `/api/projects/${projectId}/file`, { path: 'test.py', content: pyCode }, token);
    console.log('Wrote test.py');

    // 3. Connect to WS (cookie auth — query-token auth was removed)
    const wsUrl = `ws://localhost:3000/ws/execute?projectId=${projectId}`;
    const ws = new WebSocket(wsUrl, { headers: { Cookie: `session_token=${token}` } });

    let messages = [];
    ws.on('open', () => {
      console.log('WS connected.');
      ws.send(JSON.stringify({ type: 'start', file: 'test.py' }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      messages.push({ time: Date.now(), ...msg });
      console.log('WS RECV:', msg);
      
      if (msg.type === 'stdout' && msg.data.includes('Enter something:')) {
        console.log('Sending STDIN');
        ws.send(JSON.stringify({ type: 'stdin', data: 'hello world\n' }));
      }
      
      if (msg.type === 'exit') {
        console.log('WS finished, closing...');
        ws.close();
      }
    });

    ws.on('close', () => {
      console.log('WS closed. Event count:', messages.length);
      console.log('Timeline:', messages.map(m => m.type));
    });

  } catch(e) {
    console.error(e);
  }
}
run();
