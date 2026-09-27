const { spawn, spawnSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const children = [];

function pickPython(){
  for (const cmd of process.platform === 'win32' ? ['python','py'] : ['python3','python']) {
    const args = cmd === 'py' ? ['-3','--version'] : ['--version'];
    const r = spawnSync(cmd,args,{stdio:'ignore'});
    if (r.status === 0) return {cmd, prefix: cmd === 'py' ? ['-3'] : []};
  }
  return null;
}
function run(name, cmd, args, cwd){
  const p = spawn(cmd,args,{cwd,stdio:'inherit',shell:process.platform==='win32'});
  children.push(p);
  p.on('exit',code=>{ if(code && code!==0) console.error(`${name} exited with code ${code}`); });
}
const py=pickPython();
if(!py){ console.error('Python 3 was not found. Install Python 3 and run again.'); process.exit(1); }
console.log('\nALTITUDE HACKATHON SYSTEM');
console.log('Website: http://localhost:3000');
console.log('Gateway: http://localhost:8080');
console.log('Health:  http://localhost:8000\n');
run('Python',py.cmd,[...py.prefix,'service.py'],path.join(root,'python-service'));
run('Gateway','node',['server.js'],path.join(root,'node-backend'));
run('Website',process.platform==='win32'?'npm.cmd':'npm',['run','dev'],path.join(root,'frontend'));
function shutdown(){ for(const p of children){ try{p.kill();}catch{} } process.exit(); }
process.on('SIGINT',shutdown); process.on('SIGTERM',shutdown);
