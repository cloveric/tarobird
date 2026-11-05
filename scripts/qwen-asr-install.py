#!/usr/bin/env python3
"""Shared, optional local ASR installer. No shell evaluation and no model import."""
import argparse
import contextlib
import json
import hashlib
import signal
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

LABEL = 'com.tarobot.qwen3-asr'
UNIT = 'tarobot-qwen3-asr.service'
MODEL = 'Qwen/Qwen3-ASR-0.6B'
FILES = ('server.py', 'transcribe.py', 'requirements.txt', 'README.md')

class InstallError(Exception):
    pass

def safe(path):
    path = Path(path)
    if not path.is_absolute() or any(c in str(path) for c in '\n\r\x00'):
        raise InstallError('invalid_path')
    for part in [path, *path.parents]:
        if part.is_symlink():
            raise InstallError('unsafe_symlink')
    if path.exists() and not (path.is_dir() or path.is_file()):
        raise InstallError('unsafe_file')
    return path

def read_json(path):
    safe(path)
    if not path.exists(): return None
    if path.stat().st_size > 65536: raise InstallError('invalid_configuration')
    return json.loads(path.read_text())

def atomic(path, data, mode=0o600):
    safe(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix='.asr-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            os.fchmod(f.fileno(), mode)
            f.write(data if isinstance(data, bytes) else data.encode())
            f.flush(); os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)

def model_present(model):
    try:
        config = json.loads((model/'config.json').read_text())
        if config.get('model_type') != 'qwen3_asr': return False
        if any(not (model/name).is_file() or (model/name).stat().st_size == 0 for name in ['tokenizer_config.json', 'vocab.json', 'merges.txt', 'preprocessor_config.json']): return False
        weights = [model/'model.safetensors']
        index = model/'model.safetensors.index.json'
        if index.is_file():
            names = set(json.loads(index.read_text())['weight_map'].values())
            if not names or any(Path(n).name != n for n in names): return False
            weights = [model/n for n in names]
        for weight in weights:
            with weight.open('rb') as f:
                length = int.from_bytes(f.read(8), 'little')
                if not 0 < length <= 16*1024**2: return False
                header = json.loads(f.read(length))
                offsets = [v['data_offsets'][1] for k,v in header.items() if k != '__metadata__']
                if not offsets or max(offsets) + 8 + length != weight.stat().st_size: return False
        return True
    except (OSError, ValueError, KeyError, TypeError): return False

def free_bytes(path):
    while not path.exists(): path=path.parent
    return shutil.disk_usage(path).free

def check_space(path, required):
    if free_bytes(path) < required: raise InstallError('insufficient_disk_space')

def probe(port, route):
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{port}/{route}', timeout=2) as r:
            data=r.read(32769)
            if len(data)>32768: return None
            return json.loads(data) if route == 'status' else data.decode().strip()
    except Exception: return None

def config_for(target):
    record=read_json(target/'installation.json') or {}
    if record and (record.get('format') != 1 or not isinstance(record.get('modelPath'),str) or not isinstance(record.get('installationId'),str) or not isinstance(record.get('port'),int) or not 1024 <= record['port'] <= 65535):
        raise InstallError('invalid_configuration')
    return record

def status(target):
    record=config_for(target)
    model=Path(os.environ.get('ASR_MODEL_PATH') or record.get('modelPath') or target/'models/Qwen3-ASR-0.6B')
    port=record.get('port',8412)
    live=probe(port,'status')
    trusted=isinstance(live,dict) and live.get('service')=='tarobot-qwen3-asr' and live.get('format')==1
    matching=trusted and bool(record) and live.get('installationId')==record.get('installationId')
    running=trusted or probe(port,'health')=='ok'
    return {'platform':sys.platform,'supported':sys.platform in ('darwin','linux'),
        'installed':(target/'server.py').is_file(),'pythonPresent':(target/('.venv/Scripts/python.exe' if sys.platform=='win32' else '.venv/bin/python')).is_file(),
        'modelPresent':model_present(model),'running':running,'managed':bool(matching and record.get('service')),
        'legacyService':running and not matching,'activeRequests':live.get('activeRequests') if trusted else None,
        'watchdog':live.get('watchdog') if trusted else None,
        'autostart':'login' if record.get('service') else 'disabled'}

def env_quote(value):
    return '"'+value.replace('\\','\\\\').replace('"','\\"').replace('$','\\$').replace('`','\\`').replace('\n','\\n')+'"'

def update_env(home, values):
    dest=safe(home/'.tarobot/integrations.env')
    text=dest.read_text() if dest.exists() else ''
    lines=[line for line in text.splitlines() if line.split('=',1)[0].strip() not in values]
    lines += [key+'='+env_quote(value) for key,value in values.items()]
    atomic(dest,'\n'.join(lines)+'\n')

def service_plan(target, model, installation_id, platform=None, home=None, port=8412):
    platform=platform or sys.platform; home=home or Path.home()
    if any(c in str(target) or c in str(model) for c in ('\r','\n','\x00')): raise InstallError('invalid_path')
    python=target/'.venv/bin/python'
    bins=[str(Path(value).parent) for tool in ('ffmpeg','ffprobe') if (value:=shutil.which(tool))]
    service_path=':'.join(dict.fromkeys([*bins,'/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin']))
    env={'ASR_MODEL_PATH':str(model),'ASR_PORT':str(port),'ASR_RECYCLE_IDLE':'1',
         'ASR_INSTALLATION_ID':installation_id,'ASR_CONTROL_LOCK':str(target/'service-control.lock'),'PYTHONUNBUFFERED':'1',
         'PATH':service_path}
    if platform=='darwin':
        dest=home/'Library/LaunchAgents'/f'{LABEL}.plist'
        data=plistlib.dumps({'Label':LABEL,'ProgramArguments':[str(python),str(target/'server.py')],
            'WorkingDirectory':str(target),'EnvironmentVariables':env,'KeepAlive':True,'RunAtLoad':True,'ThrottleInterval':15,
            'StandardOutPath':str(target/'service.stdout.log'),'StandardErrorPath':str(target/'service.stderr.log')})
        commands=[['launchctl','enable',f'gui/{os.getuid()}/{LABEL}'],['launchctl','bootstrap',f'gui/{os.getuid()}',str(dest)]]
        stop=['launchctl','bootout',f'gui/{os.getuid()}/{LABEL}']
        restart=['launchctl','kickstart','-k',f'gui/{os.getuid()}/{LABEL}']
    elif platform=='linux':
        dest=home/'.config/systemd/user'/UNIT
        def quote(value, command=False):
            value=value.replace('\\','\\\\').replace('"','\\"').replace('%','%%')
            if command: value=value.replace('$','$$')
            return '"'+value+'"'
        data='[Unit]\nDescription=TaroBot local Qwen3-ASR\n[Service]\nType=simple\n'
        data+='ExecStart='+quote(str(python),True)+' '+quote(str(target/'server.py'),True)+'\n'
        data+='WorkingDirectory='+str(target).replace('%','%%')+'\n'
        data+='\n'.join('Environment='+quote(k+'='+v) for k,v in env.items())+'\nRestart=always\nRestartSec=15\n[Install]\nWantedBy=default.target\n'
        commands=[['systemctl','--user','daemon-reload'],['systemctl','--user','enable','--now',UNIT]]
        stop=['systemctl','--user','disable','--now',UNIT]
        restart=['systemctl','--user','restart',UNIT]
    else: raise InstallError('platform_unsupported')
    return dest,data,commands,stop,restart

def run(args, *, timeout=3600):
    subprocess.run([str(x) for x in args],check=True,timeout=timeout)

def phase(value):
    print('TAROBOT_ASR_PHASE='+value,flush=True)

@contextlib.contextmanager
def install_lock(home):
    import fcntl
    dest=safe(home/'.tarobot/asr-install.lock');dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd=os.open(dest,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise InstallError('installation_busy')
        yield
    finally: os.close(fd)

def install(args):
    target=safe(Path(args.dir));home=Path.home();source=Path(__file__).resolve().parents[1]/'integrations/qwen3-asr'
    if target.resolve()==source.resolve(): raise InstallError('source_directory_conflict')
    record=config_for(target)
    explicit=os.environ.get('ASR_MODEL_PATH')
    model=Path(explicit or record.get('modelPath') or target/'models/Qwen3-ASR-0.6B').expanduser()
    if not model.is_absolute(): raise InstallError('invalid_model_path')
    if not explicit and not record.get('modelPath') and not model_present(model):
        legacy=home/'projects/qwen3-asr/models/Qwen3-ASR-0.6B'
        if model_present(legacy): model=legacy
    reuse=model_present(model)
    if explicit and not reuse: raise InstallError('configured_model_incomplete')
    installation_id=record.get('installationId') or str(uuid.uuid4())
    port=int(os.environ.get('ASR_PORT',record.get('port',8412)))
    if not 1024<=port<=65535: raise InstallError('invalid_port')
    plan=service_plan(target,model,installation_id,port=port) if args.as_service else None
    if args.dry_run:
        print(json.dumps({'target':str(target),'reuseModel':reuse,'downloadModel':args.with_model and not reuse,
                         'serviceFile':str(plan[0]) if plan else None,'serviceContents':plan[1].decode() if plan and isinstance(plan[1],bytes) else plan[1] if plan else None,'commands':plan[2] if plan else []}))
        return
    if sys.platform not in ('darwin','linux'): raise InstallError('platform_unsupported')
    with install_lock(home):
        phase('checking')
        if args.as_service:
            with socket.socket() as s:
                try: s.bind(('127.0.0.1',port))
                except OSError: raise InstallError('service_port_in_use')
            if plan[0].exists(): raise InstallError('service_already_registered')
            safe(home/'.tarobot/integrations.env')
            manager=['launchctl','print',f'gui/{os.getuid()}'] if sys.platform=='darwin' else ['systemctl','--user','show-environment']
            try:
                if subprocess.run(manager,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15).returncode: raise InstallError('service_manager_unavailable')
            except (OSError,subprocess.SubprocessError): raise InstallError('service_manager_unavailable')
            if not shutil.which('ffmpeg') or not shutil.which('ffprobe'): raise InstallError('ffmpeg_required')
        stamp = hashlib.sha256((source/'requirements.txt').read_bytes()+b'python3.12').hexdigest()
        stamp_file = target/'dependencies.sha256'
        need_deps = not args.no_deps and (not stamp_file.is_file() or stamp_file.read_text().strip()!=stamp or not (target/'.venv/bin/python').is_file())
        if need_deps:
            current = probe(port, 'status')
            if isinstance(current,dict) and current.get('installationId')==installation_id:
                raise InstallError('service_must_stop_before_upgrade')
            if sys.version_info[:2] != (3,12): raise InstallError('python_312_required')
            check_space(target,8*1024**3)
        if args.with_model and not reuse: check_space(model,4*1024**3)
        target.mkdir(parents=True,exist_ok=True,mode=0o700);target.chmod(0o700)
        safe(target/'.venv')
        if need_deps:
            phase('dependencies'); run([sys.executable,'-m','venv',target/'.venv'])
            run([target/'.venv/bin/python','-m','pip','install','-r',source/'requirements.txt'])
            atomic(stamp_file,stamp)
        if args.with_model and not reuse:
            phase('model');model.mkdir(parents=True,exist_ok=True)
            run([target/'.venv/bin/hf','download',MODEL,'--local-dir',model])
            if not model_present(model): raise InstallError('downloaded_model_incomplete')
        if args.as_service and not model_present(model): raise InstallError('model_required')
        phase('installing')
        metadata={'format':1,'installationId':installation_id,'modelPath':str(model),'port':port,'service':record.get('service',False),'ready':model_present(model) and (target/'.venv/bin/python').is_file()}
        atomic(target/'installation.json',json.dumps(metadata))
        for name in sorted(FILES,key=lambda name: name=='transcribe.py'):
            if not (source/name).is_file() or (source/name).is_symlink(): raise InstallError('invalid_package')
            atomic(target/name,(source/name).read_bytes())
        atomic(target/'service-control.py',Path(__file__).read_bytes())
        if plan:
            phase('service'); dest,data,commands,stop,_restart=plan
            env_file=safe(home/'.tarobot/integrations.env')
            previous_env=env_file.read_bytes() if env_file.exists() else None
            previous_metadata=(target/'installation.json').read_bytes()
            atomic(dest,data)
            try:
                for cmd in commands: run(cmd,timeout=30)
                deadline=time.monotonic()+120
                while time.monotonic()<deadline:
                    live=probe(port,'status')
                    if isinstance(live,dict) and live.get('installationId')==installation_id and live.get('watchdog',{}).get('enabled') is True:
                        break
                    time.sleep(1)
                else: raise InstallError('service_start_timeout')
                python=target/'.venv/bin/python'
                update_env(home,{'ASR_HTTP_URL':f'http://127.0.0.1:{port}/transcribe','ASR_CLI_PYTHON':str(python),
                    'ASR_CLI_SCRIPT':str(target/'transcribe.py'),'ASR_MODEL_PATH':str(model),
                    'ASR_SERVICE_COMMAND':shlex.join([str(python),str(target/'service-control.py'),'--dir',str(target),'--restart'])})
                metadata['service']=True;atomic(target/'installation.json',json.dumps(metadata))
            except BaseException:
                # Keep a failed stop's registration available for explicit repair.
                # Never claim rollback succeeded while the service might remain.
                atomic(target/'installation.json',previous_metadata)
                if previous_env is None: env_file.unlink(missing_ok=True)
                else: atomic(env_file,previous_env)
                try:
                    stopped = subprocess.run(stop,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
                    absent=False
                    if stopped.returncode != 0:
                        if sys.platform=='darwin':
                            check=subprocess.run(['launchctl','print',f'gui/{os.getuid()}/{LABEL}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
                            absent=check.returncode==113
                        else:
                            loaded=subprocess.run(['systemctl','--user','is-active',UNIT],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15,text=True)
                            enabled=subprocess.run(['systemctl','--user','is-enabled',UNIT],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=15,text=True)
                            absent=loaded.stdout.strip() in ('inactive','failed','unknown') and enabled.stdout.strip() in ('disabled','not-found')
                    if stopped.returncode == 0 or absent: dest.unlink(missing_ok=True)
                except (OSError, subprocess.SubprocessError):
                    pass
                raise
        phase('completed')
        print('Local ASR source installed. Existing models and unrelated configuration are preserved.')
        if not args.as_service: print('No running service has been restarted or registered.')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dir',default=str(Path.home()/'.tarobot/integrations/qwen3-asr'))
    for flag in ('no-deps','with-model','as-service','dry-run','status','restart'): parser.add_argument('--'+flag,action='store_true')
    args=parser.parse_args();target=safe(Path(args.dir))
    if args.status: print(json.dumps(status(target)));return
    if args.restart:
        record=config_for(target)
        if not record.get('service'): raise InstallError('service_not_registered')
        import fcntl
        lock=safe(target/'service-control.lock')
        fd=os.open(lock,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        try:
            try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: raise InstallError('service_busy')
            repaired=safe(target/'last-repair')
            try:
                if repaired.exists() and 0 <= time.time()-float(repaired.read_text()) < 60: return
            except ValueError:
                pass
            live=probe(record['port'],'status')
            if isinstance(live,dict):
                if live.get('installationId') != record['installationId']: raise InstallError('service_identity_mismatch')
                if live.get('activeRequests',0)>0 or live.get('exiting'): raise InstallError('service_busy')
                # Old Host versions count input/silence errors as failures. Do not
                # restart a responsive server whose inference is still healthy.
                if live.get('consecutiveFailures') == 0: return
            plan=service_plan(target,Path(record['modelPath']),record['installationId'],port=record['port'])
            run(plan[4],timeout=30)
            atomic(repaired,str(time.time()))
        finally: os.close(fd)
        return
    install(args)

if __name__=='__main__':
    def terminate(_signal,_frame): raise InstallError('installation_interrupted')
    signal.signal(signal.SIGTERM,terminate)
    try: main()
    except InstallError as e:
        print('TAROBOT_ASR_ERROR='+str(e),file=sys.stderr);sys.exit(1)
    except (OSError,ValueError,subprocess.SubprocessError):
        print('TAROBOT_ASR_ERROR=installation_failed',file=sys.stderr);sys.exit(1)
