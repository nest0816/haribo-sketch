
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const viewport = document.getElementById('viewport');
const stage = document.getElementById('stage');

const colorInput = document.getElementById('color');
const sizeInput = document.getElementById('size');
const opacityInput = document.getElementById('opacity');
const smoothingInput = document.getElementById('smoothing');

const sizeValue = document.getElementById('sizeValue');
const opacityValue = document.getElementById('opacityValue');
const smoothingValue = document.getElementById('smoothingValue');
const hexValue = document.getElementById('hexValue');
const zoomLabel = document.getElementById('zoomLabel');
const expiryCountdown = document.getElementById('expiryCountdown');
const connectionLabel = document.getElementById('connectionLabel');
const roomCodeLabel = document.getElementById('roomCode');
const participantsEl = document.getElementById('participants');
const participantCountEl = document.getElementById('participantCount');

const WIDTH = canvas.width, HEIGHT = canvas.height;
const ROOM_LIFETIME_MS = 8 * 60 * 1000;

let tool = 'brush';
let brushType = 'fixed';
let drawing = false;
let zoom = .72;
let pan = {x:0,y:0};
let spaceDown = false;
let panning = false;
let panStart = null;
let smoothPoint = null;
let currentStrokeId = null;

const myId = crypto.randomUUID();
const myName = 'guest-' + myId.slice(0,4);

const params = new URLSearchParams(location.search);
let roomId = params.get('room');
if(!roomId){
  roomId = Math.random().toString(36).slice(2,8);
  params.set('room', roomId);
  history.replaceState({}, '', `${location.pathname}?${params.toString()}`);
}
roomCodeLabel.textContent = roomId;

const expiryKey = `haribo-room-expiry-${roomId}`;
let expiresAt = Number(localStorage.getItem(expiryKey));
if(!expiresAt || expiresAt <= Date.now()){
  expiresAt = Date.now() + ROOM_LIFETIME_MS;
  localStorage.setItem(expiryKey, String(expiresAt));
}

function clearCanvas(){
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0,0,WIDTH,HEIGHT);
  ctx.restore();
}
clearCanvas();

function updateTransform(){
  stage.style.transform = `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`;
  zoomLabel.textContent = `${Math.round(zoom*100)}%`;
}

function canvasPointFromEvent(e){
  const rect = canvas.getBoundingClientRect();
  return {
    x:(e.clientX-rect.left)*WIDTH/rect.width,
    y:(e.clientY-rect.top)*HEIGHT/rect.height,
    pressure:e.pressure || .5
  };
}

function getStyledWidth(pressure){
  const base = Number(sizeInput.value);
  if(brushType === 'pressure') return Math.max(1, base * (.25 + pressure * 1.1));
  return base;
}

function smooth(raw){
  const amount = Number(smoothingInput.value)/100;
  if(!smoothPoint){ smoothPoint = raw; return raw; }
  const keep = amount * .9;
  smoothPoint = {
    x:smoothPoint.x*keep + raw.x*(1-keep),
    y:smoothPoint.y*keep + raw.y*(1-keep),
    pressure:raw.pressure
  };
  return smoothPoint;
}

function drawSegment(seg){
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = seg.opacity;
  ctx.strokeStyle = seg.eraser ? '#fff' : seg.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(seg.x1,seg.y1);
  ctx.lineTo(seg.x2,seg.y2);
  ctx.lineWidth = seg.width;
  ctx.stroke();
  ctx.restore();
}

let channel = null;
let supabaseClient = null;

const cfg = window.HARIBO_CONFIG || {};
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY;

async function setupRealtime(){
  if(!configured){
    connectionLabel.textContent = '로컬 미리보기';
    renderParticipants([{id:myId,name:myName}]);
    return;
  }

  supabaseClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  channel = supabaseClient.channel(`room:${roomId}`, {
    config:{
      broadcast:{self:false},
      presence:{key:myId}
    }
  });

  channel
    .on('broadcast',{event:'stroke'}, ({payload}) => drawSegment(payload))
    .on('broadcast',{event:'clear'}, () => clearCanvas())
    .on('broadcast',{event:'room_expired'}, () => {
      clearCanvas();
      startFreshTimer();
    })
    .on('presence',{event:'sync'}, () => {
      const state = channel.presenceState();
      const people = Object.values(state).flat();
      renderParticipants(people);
    });

  await channel.subscribe(async status => {
    if(status === 'SUBSCRIBED'){
      connectionLabel.textContent = '실시간 연결됨';
      await channel.track({id:myId,name:myName,joined_at:new Date().toISOString()});
    } else {
      connectionLabel.textContent = status.toLowerCase();
    }
  });
}

function renderParticipants(list){
  participantCountEl.textContent = list.length;
  participantsEl.innerHTML = '';
  list.slice(0,12).forEach(p=>{
    const div = document.createElement('div');
    div.className='participant';
    div.innerHTML = `<div class="avatar">${(p.name||'?').slice(-2)}</div><span>${p.name||'guest'}</span>`;
    participantsEl.appendChild(div);
  });
}

function broadcast(event,payload={}){
  if(channel) channel.send({type:'broadcast',event,payload});
}

function startFreshTimer(){
  expiresAt = Date.now() + ROOM_LIFETIME_MS;
  localStorage.setItem(expiryKey,String(expiresAt));
}

function updateCountdown(){
  let remaining = expiresAt - Date.now();
  if(remaining <= 0){
    clearCanvas();
    broadcast('room_expired',{});
    startFreshTimer();
    remaining = ROOM_LIFETIME_MS;
  }
  const sec = Math.ceil(remaining/1000);
  const m = Math.floor(sec/60), s = sec%60;
  expiryCountdown.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

let lastPoint = null;
canvas.addEventListener('pointerdown', e=>{
  if(spaceDown || tool==='hand'){
    panning = true;
    panStart = {x:e.clientX-pan.x,y:e.clientY-pan.y};
    canvas.style.cursor='grabbing';
    return;
  }
  drawing = true;
  smoothPoint = null;
  currentStrokeId = crypto.randomUUID();
  lastPoint = smooth(canvasPointFromEvent(e));
  canvas.setPointerCapture?.(e.pointerId);
});

canvas.addEventListener('pointermove', e=>{
  if(panning && panStart){
    pan.x = e.clientX-panStart.x;
    pan.y = e.clientY-panStart.y;
    updateTransform();
    return;
  }
  if(!drawing) return;
  const p = smooth(canvasPointFromEvent(e));
  const seg = {
    strokeId:currentStrokeId,
    x1:lastPoint.x,y1:lastPoint.y,x2:p.x,y2:p.y,
    width:getStyledWidth(p.pressure),
    color:colorInput.value,
    opacity:Number(opacityInput.value)/100,
    eraser:tool==='eraser'
  };
  drawSegment(seg);
  broadcast('stroke',seg);
  lastPoint = p;
});

window.addEventListener('pointerup', ()=>{
  drawing=false; panning=false; panStart=null; smoothPoint=null;
  canvas.style.cursor=(tool==='hand'||spaceDown)?'grab':'crosshair';
});

document.querySelectorAll('.tool').forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll('.tool').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    tool=btn.dataset.tool;
  };
});

document.querySelectorAll('.brush-type').forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll('.brush-type').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    brushType=btn.dataset.brushType;
  };
});

sizeInput.oninput=()=>sizeValue.textContent=sizeInput.value;
opacityInput.oninput=()=>opacityValue.textContent=opacityInput.value;
smoothingInput.oninput=()=>smoothingValue.textContent=smoothingInput.value;
colorInput.oninput=()=>hexValue.textContent=colorInput.value;

document.querySelectorAll('.swatches button').forEach(btn=>{
  btn.onclick=()=>{colorInput.value=btn.dataset.color;hexValue.textContent=btn.dataset.color}
});

document.getElementById('clearBtn').onclick=()=>{
  clearCanvas();
  broadcast('clear',{});
};

document.getElementById('saveBtn').onclick=()=>{
  const a=document.createElement('a');
  a.download=`haribo-${roomId}.png`;
  a.href=canvas.toDataURL('image/png');
  a.click();
};

function copyRoom(){
  navigator.clipboard?.writeText(location.href);
}
document.getElementById('copyRoomBtn').onclick=copyRoom;
document.getElementById('copyRoomBtn2').onclick=copyRoom;

document.getElementById('zoomIn').onclick=()=>{zoom=Math.min(2.5,zoom+.1);updateTransform()};
document.getElementById('zoomOut').onclick=()=>{zoom=Math.max(.2,zoom-.1);updateTransform()};
document.getElementById('zoomReset').onclick=()=>{
  zoom=Math.max(.2,Math.min(1.2,Math.min((viewport.clientWidth-40)/WIDTH,(viewport.clientHeight-40)/HEIGHT)));
  pan={x:0,y:0};updateTransform();
};

window.addEventListener('keydown',e=>{
  if(e.code==='Space'){e.preventDefault();spaceDown=true;canvas.style.cursor='grab'}
});
window.addEventListener('keyup',e=>{
  if(e.code==='Space'){spaceDown=false;canvas.style.cursor=tool==='hand'?'grab':'crosshair'}
});

updateTransform();
setupRealtime();
updateCountdown();
setInterval(updateCountdown,1000);
setTimeout(()=>document.getElementById('zoomReset').click(),50);
