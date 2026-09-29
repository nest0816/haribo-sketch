
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
const layersEl = document.getElementById('layers');
const addLayerBtn = document.getElementById('addLayerBtn');
const chatMessagesEl = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

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
let currentStrokeSegments = [];
let expiresAt = Date.now() + ROOM_LIFETIME_MS;
let cachedRows = [];

const USER_ID_KEY = 'haribo-sketch-user-id-v1';
let myId = localStorage.getItem(USER_ID_KEY);
if(!myId){
  myId = crypto.randomUUID();
  localStorage.setItem(USER_ID_KEY, myId);
}
const myName = 'guest-' + myId.slice(0,4);

const params = new URLSearchParams(location.search);
let roomId = params.get('room');
const explicitRoom = Boolean(roomId);
let roomMode = explicitRoom ? 'private' : 'public';

const roomModeBadge = document.getElementById('roomModeBadge');
const roomDescription = document.getElementById('roomDescription');
const roomOccupancy = document.getElementById('roomOccupancy');

function updateRoomLabels(){
  roomCodeLabel.textContent = roomId || '찾는 중…';
  if(roomMode === 'public'){
    roomModeBadge.textContent = 'PUBLIC';
    roomDescription.textContent = '최대 30명 공개방 · 꽉 차면 다음 방으로 자동 배정돼요.';
  }else{
    roomModeBadge.textContent = 'PRIVATE';
    roomDescription.textContent = '이 링크를 공유하면 친구들이 같은 방으로 들어올 수 있어요.';
  }
}
updateRoomLabels();

// ----- personal layers -----
const layerCountKey = `haribo-layer-count-${roomId}`;
const activeLayerKey = `haribo-active-layer-${roomId}`;
let layerCount = Math.max(1, Math.min(3, Number(localStorage.getItem(layerCountKey) || 1)));
let activeLayer = Math.max(1, Math.min(layerCount, Number(localStorage.getItem(activeLayerKey) || 1)));
const hiddenLayers = new Set();

function renderLayers(){
  layersEl.innerHTML = '';

  for(let n=1;n<=layerCount;n++){
    const row = document.createElement('div');
    row.className = 'layer-row';

    const eye = document.createElement('button');
    eye.className = 'layer-eye';
    eye.textContent = hiddenLayers.has(n) ? '🙈' : '👁';
    eye.title = hiddenLayers.has(n) ? '레이어 보이기' : '레이어 숨기기';
    eye.onclick = async ()=>{
      if(hiddenLayers.has(n)) hiddenLayers.delete(n);
      else hiddenLayers.add(n);
      renderLayers();
      redrawFromCache();
    };

    const select = document.createElement('button');
    select.className = 'layer-select' + (activeLayer===n ? ' active' : '');
    select.textContent = `레이어 ${n}`;
    select.onclick = ()=>{
      activeLayer = n;
      localStorage.setItem(activeLayerKey, String(activeLayer));
      renderLayers();
    };

    row.appendChild(eye);
    row.appendChild(select);
    layersEl.appendChild(row);
  }

  addLayerBtn.disabled = layerCount >= 3;
  addLayerBtn.textContent = layerCount >= 3 ? '최대 3개' : '＋ 레이어';
}

addLayerBtn.onclick = ()=>{
  if(layerCount >= 3) return;
  layerCount += 1;
  activeLayer = layerCount;
  localStorage.setItem(layerCountKey, String(layerCount));
  localStorage.setItem(activeLayerKey, String(activeLayer));
  renderLayers();
};
renderLayers();

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

function rowVisible(row){
  if(row.client_id === myId && hiddenLayers.has(Number(row.layer_no || 1))) return false;
  return true;
}

function redrawFromCache(){
  clearCanvas();

  const ordered = cachedRows.slice().sort((a,b)=>{
    const la = Number(a.layer_no || 1);
    const lb = Number(b.layer_no || 1);
    if(la !== lb) return la-lb;
    return Number(a.id)-Number(b.id);
  });

  ordered.forEach(row=>{
    if(!rowVisible(row)) return;
    const payload = row.payload || {};
    if(payload.type === 'stroke' && Array.isArray(payload.segments)){
      payload.segments.forEach(drawSegment);
    }
  });
}

let channel = null;
let supabaseClient = null;

const cfg = window.HARIBO_CONFIG || {};
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY;

function showStatus(message, isError=false){
  if(!connectionLabel) return;
  connectionLabel.textContent = message;
  connectionLabel.style.color = isError ? '#c13b5b' : '';
}



const PUBLIC_ROOM_LIMIT = 30;
let heartbeatTimer = null;

async function assignPublicRoom(){
  if(!supabaseClient) return;

  const { data, error } = await supabaseClient.rpc('join_public_room', {
    p_client_id: myId,
    p_nickname: myName
  });

  if(error) throw error;

  const assigned = Array.isArray(data) ? data[0] : data;
  if(!assigned?.room_id) throw new Error('공개방 배정 실패');

  roomId = assigned.room_id;
  roomMode = 'public';
  expiresAt = new Date(assigned.expires_at).getTime();

  params.set('room', roomId);
  params.set('public', '1');
  history.replaceState({}, '', `${location.pathname}?${params.toString()}`);

  updateRoomLabels();
}

async function registerPrivateRoomMember(){
  if(!supabaseClient || !roomId) return;
  await supabaseClient.rpc('touch_room_member', {
    p_room_id: roomId,
    p_client_id: myId,
    p_nickname: myName
  });
}

async function heartbeatRoomMember(){
  if(!supabaseClient || !roomId) return;
  await supabaseClient.rpc('touch_room_member', {
    p_room_id: roomId,
    p_client_id: myId,
    p_nickname: myName
  });
}

async function refreshOccupancy(){
  if(!supabaseClient || !roomId) return;

  const { data, error } = await supabaseClient.rpc('room_active_count', {
    p_room_id: roomId
  });

  if(!error && roomOccupancy){
    roomOccupancy.textContent = String(data ?? 1);
  }
}

function startHeartbeat(){
  clearInterval(heartbeatTimer);
  heartbeatRoomMember();
  refreshOccupancy();

  heartbeatTimer = setInterval(()=>{
    heartbeatRoomMember();
    refreshOccupancy();
  }, 15000);
}

async function ensureRoom(){
  const { data, error } = await supabaseClient.rpc('ensure_room', {
    p_room_id: roomId,
    p_room_type: roomMode === 'public' ? 'public' : 'private'
  });

  if(error) throw error;
  expiresAt = new Date(data).getTime();
}

async function loadRoomHistory(){
  const { data, error } = await supabaseClient
    .from('strokes')
    .select('id, client_id, layer_no, payload, created_at')
    .eq('room_id', roomId)
    .order('id', { ascending:true });

  if(error) throw error;

  cachedRows = data || [];
  redrawFromCache();
}

async function loadChatHistory(){
  const { data, error } = await supabaseClient
    .from('chat_messages')
    .select('id, client_id, nickname, message, created_at')
    .eq('room_id', roomId)
    .order('id', { ascending:true });

  if(error) throw error;

  renderChat(data || []);
}

async function persistStroke(segments){
  if(!supabaseClient || !segments.length) return;

  const payload = {
    type:'stroke',
    segments
  };

  const { data, error } = await supabaseClient.rpc('save_room_stroke', {
    p_room_id: roomId,
    p_client_id: myId,
    p_layer_no: activeLayer,
    p_payload: payload
  });

  if(error){
    console.error('save_room_stroke failed', error);
    showStatus('그림 저장 오류', true);
    return;
  }

  cachedRows.push({
    id:Number(data),
    room_id:roomId,
    client_id:myId,
    layer_no:activeLayer,
    payload,
    created_at:new Date().toISOString()
  });

  showStatus('실시간 연결됨');
}

async function deleteMyDrawings(){
  if(!supabaseClient) return;

  const { data, error } = await supabaseClient.rpc('clear_my_room_strokes', {
    p_room_id: roomId,
    p_client_id: myId
  });

  if(error){
    console.error('clear_my_room_strokes failed', error);
    showStatus('내 그림 지우기 오류', true);
    return;
  }

  await loadRoomHistory();
  broadcast('owner_clear', { ownerId: myId });
  showStatus(`내 그림 삭제됨 (${Number(data || 0)}개)`);
  setTimeout(()=>showStatus('실시간 연결됨'), 1200);
}


async function undoMyLastStroke(){
  if(!supabaseClient) return;

  const { data, error } = await supabaseClient.rpc('undo_my_last_room_stroke', {
    p_room_id: roomId,
    p_client_id: myId
  });

  if(error){
    console.error('undo_my_last_room_stroke failed', error);
    showStatus('되돌리기 오류', true);
    return;
  }

  if(data === null){
    showStatus('되돌릴 내 선이 없어요');
    setTimeout(()=>showStatus('실시간 연결됨'), 1000);
    return;
  }

  await loadRoomHistory();
  broadcast('owner_undo', { ownerId: myId, strokeId: Number(data) });
  showStatus('마지막 선 되돌림');
  setTimeout(()=>showStatus('실시간 연결됨'), 1000);
}

async function setupRealtime(){
  if(!configured){
    showStatus('로컬 미리보기');
    renderParticipants([{id:myId,name:myName}]);
    renderChat([]);
    return;
  }

  supabaseClient = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_ANON_KEY
  );

  try{
    showStatus('방 찾는 중…');

    if(!explicitRoom){
      await assignPublicRoom();
    }else{
      await ensureRoom();
      await registerPrivateRoomMember();
    }

    await Promise.all([loadRoomHistory(), loadChatHistory()]);

    channel = supabaseClient.channel(`room:${roomId}`, {
      config:{
        broadcast:{self:false},
        presence:{key:myId}
      }
    });

    channel
      .on('broadcast',{event:'stroke'}, ({payload}) => {
        if(payload.ownerId === myId && hiddenLayers.has(Number(payload.layerNo || 1))) return;
        drawSegment(payload.segment);
      })
      .on('broadcast',{event:'owner_clear'}, async () => {
        await loadRoomHistory();
      })
      .on('broadcast',{event:'owner_undo'}, async () => {
        await loadRoomHistory();
      })
      .on('broadcast',{event:'chat'}, ({payload}) => {
        appendChat(payload);
      })
      .on('broadcast',{event:'room_expired'}, async ({payload}) => {
        clearCanvas();
        cachedRows = [];
        renderChat([]);
        if(payload?.expiresAt){
          expiresAt = payload.expiresAt;
        }else{
          await ensureRoom();
        }
      })
      .on('presence',{event:'sync'}, () => {
        const state = channel.presenceState();
        const people = Object.values(state).flat();
        renderParticipants(people);
        if(roomOccupancy) roomOccupancy.textContent = String(people.length);
      });

    await channel.subscribe(async status => {
      if(status === 'SUBSCRIBED'){
        showStatus('실시간 연결됨');
        await channel.track({
          id:myId,
          name:myName,
          joined_at:new Date().toISOString()
        });
        startHeartbeat();
      } else {
        showStatus(status.toLowerCase());
      }
    });
  }catch(err){
    console.error(err);
    showStatus('Supabase 설정 확인 필요', true);
  }
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

function renderChat(rows){
  chatMessagesEl.innerHTML = '';
  if(!rows.length){
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = '아직 메시지가 없어요 💬';
    chatMessagesEl.appendChild(empty);
    return;
  }
  rows.forEach(appendChat);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function appendChat(row){
  const existingEmpty = chatMessagesEl.querySelector('.chat-empty');
  if(existingEmpty) existingEmpty.remove();

  const div = document.createElement('div');
  div.className = 'chat-msg' + (row.client_id === myId ? ' mine' : '');

  const name = document.createElement('b');
  name.textContent = row.nickname || 'guest';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = row.message || '';

  div.appendChild(name);
  div.appendChild(bubble);
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

async function sendChat(){
  const message = chatInput.value.trim();
  if(!message || !supabaseClient) return;

  chatSendBtn.disabled = true;

  const { data, error } = await supabaseClient.rpc('send_room_chat', {
    p_room_id: roomId,
    p_client_id: myId,
    p_nickname: myName,
    p_message: message
  });

  chatSendBtn.disabled = false;

  if(error){
    console.error('send_room_chat failed', error);
    showStatus('채팅 전송 오류', true);

    // 채팅창에도 바로 오류를 보여줘 원인을 눈치챌 수 있게 함
    const err = document.createElement('div');
    err.className = 'chat-empty';
    err.textContent = '메시지를 보내지 못했어요. Supabase SQL 설정을 확인해주세요.';
    chatMessagesEl.appendChild(err);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    return;
  }

  chatInput.value = '';

  const row = {
    id:Number(data),
    client_id:myId,
    nickname:myName,
    message,
    created_at:new Date().toISOString()
  };

  appendChat(row);
  broadcast('chat', row);
  showStatus('실시간 연결됨');
}

chatSendBtn.onclick = sendChat;
chatInput.addEventListener('keydown', e=>{
  if(e.key === 'Enter'){
    e.preventDefault();
    sendChat();
  }
});

function broadcast(event,payload={}){
  if(channel) channel.send({type:'broadcast',event,payload});
}

let resettingRoom = false;

async function resetExpiredRoom(){
  if(resettingRoom) return;
  resettingRoom = true;

  try{
    clearCanvas();
    cachedRows = [];
    renderChat([]);

    if(!supabaseClient){
      expiresAt = Date.now() + ROOM_LIFETIME_MS;
      return;
    }

    const { data, error } = await supabaseClient.rpc('reset_room_8min', {
      p_room_id: roomId,
      p_room_type: roomMode === 'public' ? 'public' : 'private'
    });

    if(error){
      console.error('reset_room_8min failed', error);
      showStatus('방 초기화 오류', true);
      return;
    }

    expiresAt = new Date(data).getTime();
    broadcast('room_expired',{ expiresAt });
  }finally{
    resettingRoom = false;
  }
}

function updateCountdown(){
  let remaining = expiresAt - Date.now();

  if(remaining <= 0){
    expiryCountdown.textContent = '00:00';
    resetExpiredRoom();
    return;
  }

  const sec = Math.ceil(remaining/1000);
  const m = Math.floor(sec/60), s = sec%60;
  expiryCountdown.textContent =
    `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
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
  currentStrokeSegments = [];
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
    x1:lastPoint.x,
    y1:lastPoint.y,
    x2:p.x,
    y2:p.y,
    width:getStyledWidth(p.pressure),
    color:colorInput.value,
    opacity:Number(opacityInput.value)/100,
    eraser:tool==='eraser'
  };

  drawSegment(seg);

  broadcast('stroke',{
    ownerId:myId,
    layerNo:activeLayer,
    segment:seg
  });

  currentStrokeSegments.push(seg);
  lastPoint = p;
});

window.addEventListener('pointerup', async ()=>{
  if(drawing && currentStrokeSegments.length){
    const toSave = currentStrokeSegments.slice();
    currentStrokeSegments = [];
    await persistStroke(toSave);
  }

  drawing=false;
  panning=false;
  panStart=null;
  smoothPoint=null;
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
  btn.onclick=()=>{
    colorInput.value=btn.dataset.color;
    hexValue.textContent=btn.dataset.color;
  };
});

document.getElementById('clearBtn').onclick=async ()=>{
  await deleteMyDrawings();
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

document.getElementById('zoomIn').onclick=()=>{
  zoom=Math.min(2.5,zoom+.1);
  updateTransform();
};
document.getElementById('zoomOut').onclick=()=>{
  zoom=Math.max(.2,zoom-.1);
  updateTransform();
};
document.getElementById('zoomReset').onclick=()=>{
  zoom=Math.max(
    .2,
    Math.min(
      1.2,
      Math.min(
        (viewport.clientWidth-40)/WIDTH,
        (viewport.clientHeight-40)/HEIGHT
      )
    )
  );
  pan={x:0,y:0};
  updateTransform();
};


function isTypingTarget(target){
  if(!target) return false;
  const tag = target.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || target.isContentEditable;
}

function activateTool(nextTool){
  tool = nextTool;
  document.querySelectorAll('.tool').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tool === nextTool);
  });
  canvas.style.cursor = nextTool === 'hand' ? 'grab' : 'crosshair';
}

function changeBrushSize(delta){
  const min = Number(sizeInput.min) || 1;
  const max = Number(sizeInput.max) || 80;
  const next = Math.max(min, Math.min(max, Number(sizeInput.value) + delta));
  sizeInput.value = String(next);
  sizeValue.textContent = String(next);
}

window.addEventListener('keydown', async e=>{
  const typing = isTypingTarget(e.target);

  if(e.code === 'Space' && !typing){
    e.preventDefault();
    spaceDown = true;
    canvas.style.cursor = 'grab';
    return;
  }

  if(typing) return;

  // Ctrl/Cmd + Z : 내 마지막 스트로크만 되돌리기
  if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'){
    e.preventDefault();
    await undoMyLastStroke();
    return;
  }

  if(e.key.toLowerCase() === 'e'){
    e.preventDefault();
    activateTool('eraser');
    return;
  }

  if(e.key.toLowerCase() === 'b'){
    e.preventDefault();
    activateTool('brush');
    return;
  }

  if(e.key === '['){
    e.preventDefault();
    changeBrushSize(-2);
    return;
  }

  if(e.key === ']'){
    e.preventDefault();
    changeBrushSize(2);
    return;
  }
});

window.addEventListener('keyup',e=>{
  if(e.code==='Space'){
    spaceDown=false;
    canvas.style.cursor=tool==='hand'?'grab':'crosshair';
  }
});

// 마우스 휠 확대/축소
viewport.addEventListener('wheel', e=>{
  // 채팅/입력 영역 스크롤에는 개입하지 않음
  if(isTypingTarget(e.target)) return;

  e.preventDefault();

  const rect = viewport.getBoundingClientRect();
  const mouseX = e.clientX - rect.left - rect.width / 2;
  const mouseY = e.clientY - rect.top - rect.height / 2;

  const oldZoom = zoom;
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  zoom = Math.max(.2, Math.min(2.5, zoom * factor));

  // 마우스 포인터가 가리키던 캔버스 위치가 크게 튀지 않도록 팬 보정
  const scaleRatio = zoom / oldZoom;
  pan.x = mouseX - (mouseX - pan.x) * scaleRatio;
  pan.y = mouseY - (mouseY - pan.y) * scaleRatio;

  updateTransform();
}, { passive:false });

updateTransform();
setupRealtime();
updateCountdown();
setInterval(updateCountdown,1000);
setTimeout(()=>document.getElementById('zoomReset').click(),50);
