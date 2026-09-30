
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const liveCanvas = document.getElementById('liveCanvas');
const liveCtx = liveCanvas.getContext('2d');

const remoteCanvas = document.createElement('canvas');
remoteCanvas.width = canvas.width;
remoteCanvas.height = canvas.height;
remoteCanvas.className = 'remote-live-canvas';
canvas.parentElement.appendChild(remoteCanvas);
const remoteCtx = remoteCanvas.getContext('2d');
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
const brushCursor = document.getElementById('brushCursor');
const brandHome = document.getElementById('brandHome');
const toolSettingsTitle = document.getElementById('toolSettingsTitle');
const brushOnlySettings = document.getElementById('brushOnlySettings');
const brushExtraSettings = document.getElementById('brushExtraSettings');
const sizePresets = document.getElementById('sizePresets');

const lobbyOverlay = document.getElementById('lobbyOverlay');
const lobbyNickname = document.getElementById('lobbyNickname');
const lobbyMessage = document.getElementById('lobbyMessage');
const nicknameBtn = document.getElementById('nicknameBtn');
const myNicknameEl = document.getElementById('myNickname');


const WIDTH = canvas.width, HEIGHT = canvas.height;

const strokeBuffer = document.createElement('canvas');
strokeBuffer.width = WIDTH;
strokeBuffer.height = HEIGHT;
const strokeBufferCtx = strokeBuffer.getContext('2d');

let currentStrokeOpacity = 1;
let currentStrokeIsEraser = false;

const remoteStrokeBuffers = new Map();
const completedStrokeIds = new Set();
let remoteFrame = null;
let roomGeneration = 0;
let roomReady = false;
let channelReady = false;
let joiningRoom = false;
let leavingRoom = false;
let historyLoading = null;
let chatLoading = null;
let mutationQueue = Promise.resolve();
let reconciliationTimer = null;
let heartbeatInFlight = false;
let heartbeatRequest = null;
const deletedRowIds = new Set();
const pendingCommits = new Map();
const pendingLocalStrokes = new Map();
let lobbyCountInFlight = false;
let chatSending = false;
let chatAtLatest = true;
let unreadChatCount = 0;
let chatPagingInFlight = false;
const chatOlderBtn = document.getElementById('chatOlderBtn');
const chatLatestBtn = document.getElementById('chatLatestBtn');
let leaveSent = false;
let strokeLayer = 1;
let strokeGeneration = 0;
const chatIds = new Set();
const MAX_CHAT_ROWS = 200;
const HISTORY_PAGE_SIZE = 500;
const MAX_BATCH_SEGMENTS = 160;

function enqueueMutation(work){
  const next = mutationQueue.then(work);
  mutationQueue = next.catch(err => {
    console.error('room mutation failed', err);
    showStatus('저장 오류 — 연결을 확인해주세요', true);
  });
  return mutationQueue;
}

function resetTransientState(){
  if(networkFlushTimer !== null) clearTimeout(networkFlushTimer);
  networkFlushTimer = null;
  networkSegmentBuffer = [];
  drawing = false;
  activePointerId = null;
  currentStrokeSegments = [];
  currentStrokeId = null;
  lastPoint = null;
  smoothPoint = null;
  panning = false;
  panStart = null;
  remoteStrokeBuffers.clear();
  completedStrokeIds.clear();
  deletedRowIds.clear();
  pendingCommits.clear();
  pendingLocalStrokes.clear();
  chatAtLatest=true;
  unreadChatCount=0;
  liveCtx.clearRect(0,0,WIDTH,HEIGHT);
  remoteCtx.clearRect(0,0,WIDTH,HEIGHT);
}

function uniquePeople(list){
  return [...new Map(list.filter(p=>p?.id).map(p=>[p.id,p])).values()];
}
function currentPeople(){
  return uniquePeople(Object.values(channel?.presenceState?.() || {}).flat());
}

function previewInterval(){
  // Budget includes delivery fan-out; reserve other traffic outside this budget.
  const n = Math.max(1, currentPeople().length);
  const budget = Math.max(30, Number(cfg.REALTIME_ROOM_MESSAGE_BUDGET) || 600);
  return Math.max(100, Math.ceil(n*n*1000/budget));
}

function scheduleRemoteDraw(){
  if(remoteFrame !== null) return;
  remoteFrame = requestAnimationFrame(()=>{
    remoteFrame = null;
    redrawRemoteStrokes();
  });
}

// A cropped opaque buffer per active stroke avoids replaying its entire path.
function appendRemoteSegments(stroke, segments){
  const pad = 128;
  let left = stroke.left ?? WIDTH, top = stroke.top ?? HEIGHT;
  let right = stroke.right ?? 0, bottom = stroke.bottom ?? 0;
  for(const seg of segments){
    const margin = seg.width/2 + 2;
    left = Math.min(left, Math.max(0, Math.floor(Math.min(seg.x1,seg.x2)-margin)));
    top = Math.min(top, Math.max(0, Math.floor(Math.min(seg.y1,seg.y2)-margin)));
    right = Math.max(right, Math.min(WIDTH, Math.ceil(Math.max(seg.x1,seg.x2)+margin)));
    bottom = Math.max(bottom, Math.min(HEIGHT, Math.ceil(Math.max(seg.y1,seg.y2)+margin)));
  }
  if(!stroke.buffer || left < stroke.left || top < stroke.top || right > stroke.right || bottom > stroke.bottom){
    const old = stroke.buffer, oldLeft = stroke.left, oldTop = stroke.top;
    stroke.left = Math.max(0, Math.floor(left/pad)*pad);
    stroke.top = Math.max(0, Math.floor(top/pad)*pad);
    stroke.right = Math.min(WIDTH, Math.ceil(right/pad)*pad);
    stroke.bottom = Math.min(HEIGHT, Math.ceil(bottom/pad)*pad);
    stroke.buffer = document.createElement('canvas');
    stroke.buffer.width = Math.max(1,stroke.right-stroke.left);
    stroke.buffer.height = Math.max(1,stroke.bottom-stroke.top);
    stroke.context = stroke.buffer.getContext('2d');
    if(old) stroke.context.drawImage(old, oldLeft-stroke.left, oldTop-stroke.top);
  }
  stroke.context.save();
  stroke.context.translate(-stroke.left,-stroke.top);
  segments.forEach(seg=>drawOpaqueSegment(stroke.context,seg));
  stroke.context.restore();
  stroke.segments.push(...segments);
  stroke.updatedAt = Date.now();
}


const kickVoteCounts = new Map();
const myKickVotes = new Set();
let kickedFromRoom = false;


const ROOM_LIFETIME_MS = 8 * 60 * 1000;

let tool = 'brush';
let brushSize = 10;
let eraserSize = 30;
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
let activePointerId = null;
let networkSegmentBuffer = [];
let networkFlushTimer = null;
let lastInputTime = 0;
let rejectedJumpCount = 0;
let expiresAt = Date.now() + ROOM_LIFETIME_MS;
let cachedRows = [];

const USER_ID_KEY = 'haribo-sketch-user-id-v1';
let myId = localStorage.getItem(USER_ID_KEY);
if(!myId){
  myId = crypto.randomUUID();
  localStorage.setItem(USER_ID_KEY, myId);
}
const NICKNAME_KEY = 'haribo-sketch-nickname-v1';
let myName = (localStorage.getItem(NICKNAME_KEY) || `guest-${myId.slice(0,4)}`).slice(0,20);

const params = new URLSearchParams(location.search);
let roomId = params.get('room');
const FIXED_PUBLIC_ROOMS = ['public-1','public-2','public-3'];
const isFixedPublicRoom = roomId && FIXED_PUBLIC_ROOMS.includes(roomId);
const explicitRoom = Boolean(roomId);
let roomMode = isFixedPublicRoom || params.get('public') === '1'
  ? 'public'
  : (explicitRoom ? 'private' : 'lobby');

const roomModeBadge = document.getElementById('roomModeBadge');
const roomDescription = document.getElementById('roomDescription');
const roomOccupancy = document.getElementById('roomOccupancy');

function friendlyRoomName(id){
  if(id === 'public-1') return '1번방';
  if(id === 'public-2') return '2번방';
  if(id === 'public-3') return '3번방';
  return id || '방 선택 전';
}

function updateRoomLabels(){
  roomCodeLabel.textContent = friendlyRoomName(roomId);

  if(roomMode === 'public'){
    roomModeBadge.textContent = 'PUBLIC';
    roomDescription.textContent = '공개방 · 최대 30명 · 자리가 나면 다시 들어올 수 있어요.';
  }else if(roomMode === 'private'){
    roomModeBadge.textContent = 'PRIVATE';
    roomDescription.textContent = '이 링크를 공유하면 친구들이 같은 방으로 들어올 수 있어요.';
  }else{
    roomModeBadge.textContent = 'LOBBY';
    roomDescription.textContent = '공개방을 선택해주세요.';
  }

  if(myNicknameEl) myNicknameEl.textContent = `내 닉네임: ${myName}`;
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


function updateBrushCursorSize(){
  if(!brushCursor) return;

  const rect = canvas.getBoundingClientRect();
  const scaleX = rect.width / WIDTH;
  const scaleY = rect.height / HEIGHT;
  const scale = (scaleX + scaleY) / 2;

  const logicalSize = tool === 'eraser' ? eraserSize : brushSize;
  const px = Math.max(4, logicalSize * scale);
  brushCursor.style.width = `${px}px`;
  brushCursor.style.height = `${px}px`;

  brushCursor.classList.toggle('eraser', tool === 'eraser');
  brushCursor.classList.toggle('hand', tool === 'hand');
}

function moveBrushCursor(e){
  if(!brushCursor) return;
  if(tool === 'hand'){
    brushCursor.style.display = 'none';
    return;
  }

  const viewportRect = viewport.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();

  const insideCanvas =
    e.clientX >= canvasRect.left &&
    e.clientX <= canvasRect.right &&
    e.clientY >= canvasRect.top &&
    e.clientY <= canvasRect.bottom;

  if(!insideCanvas){
    brushCursor.style.display = 'none';
    return;
  }

  brushCursor.style.display = 'block';
  brushCursor.style.left = `${e.clientX - viewportRect.left}px`;
  brushCursor.style.top = `${e.clientY - viewportRect.top}px`;
  updateBrushCursorSize();
}

function hideBrushCursor(){
  if(brushCursor) brushCursor.style.display = 'none';
}

function updateTransform(){
  stage.style.transform = `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`;
  zoomLabel.textContent = `${Math.round(zoom*100)}%`;
  updateBrushCursorSize();
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
  const base = tool === 'eraser' ? eraserSize : brushSize;

  if(tool !== 'eraser' && brushType === 'pressure'){
    return Math.max(1, base * (.25 + pressure * 1.1));
  }

  return base;
}

function smooth(raw){
  const amount = Number(smoothingInput.value) / 100;

  if(amount <= 0){
    smoothPoint = {...raw};
    return {...raw};
  }

  if(!smoothPoint){
    smoothPoint = {...raw};
    return {...raw};
  }

  // 너무 뒤처지지 않는 가벼운 보정
  const follow = 1 - amount * 0.45;

  smoothPoint = {
    x:smoothPoint.x + (raw.x - smoothPoint.x) * follow,
    y:smoothPoint.y + (raw.y - smoothPoint.y) * follow,
    pressure:raw.pressure
  };

  return {...smoothPoint};
}

function drawOpaqueSegment(targetCtx, seg){
  targetCtx.save();
  targetCtx.globalCompositeOperation = 'source-over';
  targetCtx.globalAlpha = 1;
  targetCtx.strokeStyle = seg.eraser ? '#ffffff' : seg.color;
  targetCtx.lineCap = 'round';
  targetCtx.lineJoin = 'round';
  targetCtx.beginPath();
  targetCtx.moveTo(seg.x1,seg.y1);
  targetCtx.lineTo(seg.x2,seg.y2);
  targetCtx.lineWidth = seg.width;
  targetCtx.stroke();
  targetCtx.restore();
}

function drawStrokeSegments(targetCtx, segments){
  if(!segments || !segments.length) return;

  strokeBufferCtx.clearRect(0,0,WIDTH,HEIGHT);

  // 한 획 전체를 먼저 100% 불투명으로 만든다.
  segments.forEach(seg=>{
    drawOpaqueSegment(strokeBufferCtx, seg);
  });

  const first = segments[0];
  const alpha = first.eraser ? 1 : Number(first.opacity ?? 1);

  targetCtx.save();
  targetCtx.globalAlpha = alpha;
  targetCtx.globalCompositeOperation = 'source-over';
  targetCtx.drawImage(strokeBuffer,0,0);
  targetCtx.restore();

  strokeBufferCtx.clearRect(0,0,WIDTH,HEIGHT);
}

function drawSegment(seg){
  drawStrokeSegments(ctx,[seg]);
}


function redrawRemoteStrokes(){
  remoteCtx.clearRect(0,0,WIDTH,HEIGHT);
  for(const [id,stroke] of remoteStrokeBuffers){
    if(Date.now()-stroke.updatedAt > 30000){ remoteStrokeBuffers.delete(id); continue; }
    if(!stroke.buffer) continue;
    remoteCtx.save();
    remoteCtx.globalAlpha = stroke.eraser ? 1 : stroke.opacity;
    remoteCtx.drawImage(stroke.buffer,stroke.left,stroke.top);
    remoteCtx.restore();
  }
}

function receiveRemoteStrokeBatch(payload){
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  if(!segments.length || segments.length>1000 || !segments.every(validSegment)) return;

  const strokeId = segments[0]?.strokeId || payload.strokeId;
  if(!strokeId || completedStrokeIds.has(strokeId)) return;

  let stroke = remoteStrokeBuffers.get(strokeId);

  if(!stroke){
    const first = segments[0];
    stroke = {
      ownerId:payload.ownerId,
      layerNo:Number(payload.layerNo || 1),
      opacity:Number(first.opacity ?? 1),
      eraser:Boolean(first.eraser),
      segments:[]
    };
    if(remoteStrokeBuffers.size>=60) return;
    remoteStrokeBuffers.set(strokeId, stroke);
  }

  appendRemoteSegments(stroke, segments);
  scheduleRemoteDraw();
}

function finishRemoteStroke(payload){
  const strokeId = payload?.strokeId;
  if(!strokeId) return;

  if(completedStrokeIds.has(strokeId)) return;
  completedStrokeIds.add(strokeId);
  const stroke = remoteStrokeBuffers.get(strokeId);

  // stroke_end에는 전체 획도 같이 보내므로,
  // 중간 broadcast가 일부 유실되어도 최종 모양은 정확하게 복구.
  const fullSegments = Array.isArray(payload?.segments) && payload.segments.length
    ? payload.segments
    : stroke?.segments;

  if(fullSegments?.length){
    if(payload.rowId != null && !cachedRows.some(r=>String(r.id)===String(payload.rowId))){
      cachedRows.push({id:payload.rowId, client_id:payload.ownerId,
        layer_no:payload.layerNo || 1, payload:{type:'stroke',segments:fullSegments}});
    }
    if(rowVisible({client_id:payload.ownerId,layer_no:payload.layerNo})) drawStrokeSegments(ctx, fullSegments);
  }

  remoteStrokeBuffers.delete(strokeId);
  scheduleRemoteDraw();
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
      drawStrokeSegments(ctx, payload.segments);
    }
  });
  for(const row of pendingLocalStrokes.values()) if(rowVisible(row)) drawStrokeSegments(ctx,row.payload.segments);
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
let lobbyRefreshTimer = null;

async function fetchFixedRoomCounts(){
  if(!supabaseClient || lobbyCountInFlight) return;
  lobbyCountInFlight = true;
  let result;
  try{result = await supabaseClient.rpc('fixed_public_room_counts_v25');}
  catch(error){result={error};}
  finally{lobbyCountInFlight = false;}
  const {data,error} = result;

  if(error){
    console.error('fixed_public_room_counts failed', error);
    lobbyMessage.textContent = '방 인원을 불러오지 못했어요. 잠시 후 다시 시도해주세요.';
    lobbyMessage.classList.add('error');
    return;
  }

  const rows = Array.isArray(data) ? data : [];

  FIXED_PUBLIC_ROOMS.forEach(id=>{
    const row = rows.find(r=>r.room_id === id);
    const count = Number(row?.active_count || 0);
    const countEl = document.querySelector(`[data-room-count="${id}"]`);
    const btn = document.querySelector(`[data-fixed-room="${id}"]`);

    if(countEl) countEl.textContent = String(count);

    if(btn){
      const full = count >= 30;
      btn.classList.toggle('full', full);
      btn.disabled = full;
      btn.title = full ? '현재 30명이라 입장할 수 없어요.' : '';
    }
  });
}

async function joinFixedPublicRoom(targetRoomId){
  const nickname = (lobbyNickname.value.trim() || myName || `guest-${myId.slice(0,4)}`).slice(0,20);
  myName = nickname;
  localStorage.setItem(NICKNAME_KEY, myName);

  lobbyMessage.classList.remove('error');
  lobbyMessage.textContent = '방에 들어가는 중…';

  const { data, error } = await supabaseClient.rpc('join_fixed_public_room', {
    p_room_id: targetRoomId,
    p_client_id: myId,
    p_nickname: myName
  });

  if(error){
    console.error('join_fixed_public_room failed', error);
    lobbyMessage.textContent = '입장에 실패했어요. 잠시 후 다시 시도해주세요.';
    lobbyMessage.classList.add('error');
    await fetchFixedRoomCounts();
    return false;
  }

  const result = typeof data === 'string' ? JSON.parse(data) : data;

  if(!result?.ok){
    lobbyMessage.textContent =
      result?.reason === 'full'
        ? '이 방은 지금 30명이에요. 자리가 나면 다시 입장할 수 있어요.'
        : result?.reason === 'banned'
          ? '이 방에서 추방되어 이번 8분 동안 다시 들어갈 수 없어요.'
          : '지금은 입장할 수 없어요.';
    lobbyMessage.classList.add('error');
    await fetchFixedRoomCounts();
    return false;
  }

  roomId = targetRoomId;
  roomMode = 'public';
  kickVoteCounts.clear();
  myKickVotes.clear();
  expiresAt = new Date(result.expires_at).getTime();

  params.set('room', roomId);
  params.set('public', '1');
  history.replaceState({}, '', `${location.pathname}?${params.toString()}`);

  updateRoomLabels();
  lobbyOverlay.classList.add('hidden');
  clearInterval(lobbyRefreshTimer);
  lobbyRefreshTimer = null;
  return true;
}

function showLobby(){
  lobbyNickname.value = myName;
  lobbyOverlay.classList.remove('hidden');
  lobbyMessage.classList.remove('error');
  lobbyMessage.textContent = '방이 30명이면 자리가 날 때까지 기다렸다가 들어갈 수 있어요.';

  fetchFixedRoomCounts();

  clearInterval(lobbyRefreshTimer);
  lobbyRefreshTimer = setInterval(()=>{
    if(!lobbyOverlay.classList.contains('hidden')){
      if(!document.hidden) fetchFixedRoomCounts();
    }
  }, 5000 + Math.random()*1000);
}

document.querySelectorAll('.public-room-choice').forEach(btn=>{
  btn.addEventListener('click', async ()=>{
    if(btn.disabled || joiningRoom || leavingRoom) return;
    joiningRoom = true;
    try{
      const ok = await joinFixedPublicRoom(btn.dataset.fixedRoom);
      if(ok) await enterCurrentRoom();
    }catch(err){
      console.error('join failed',err);
      await returnToLobby();
      showStatus('방 연결 오류',true);
    }finally{ joiningRoom=false; }
  });
});

lobbyNickname.addEventListener('keydown', e=>{
  if(e.key === 'Enter'){
    const firstOpen = [...document.querySelectorAll('.public-room-choice')].find(b=>!b.disabled);
    firstOpen?.click();
  }
});

async function registerPrivateRoomMember(){
  if(!supabaseClient || !roomId) return;
  await supabaseClient.rpc('touch_room_member', {
    p_room_id: roomId,
    p_client_id: myId,
    p_nickname: myName
  });
}

async function heartbeatRoomMember(){
  if(!supabaseClient || !roomId || heartbeatInFlight) return;
  heartbeatInFlight = true;
  const generation=roomGeneration, targetRoom=roomId;
  try{
    heartbeatRequest = supabaseClient.rpc('heartbeat_room_member_v25',{
      p_room_id:targetRoom,p_client_id:myId,p_nickname:myName
    });
    const {data,error}=await heartbeatRequest;
    if(generation !== roomGeneration) return;
    scheduleRemoteDraw();
    for(const [id,entry] of pendingCommits) if(Date.now()-entry.updatedAt>30000) pendingCommits.delete(id);
    if(error){ showStatus('접속 확인 오류',true); return; }
    if(!data?.ok){
      if(data?.reason==='banned') await handleKickedFromRoom();
      else await returnToLobby();
      return;
    }
    if(data.expires_at){
      const next = new Date(data.expires_at).getTime();
      if(next > expiresAt) applyRoomExpiry(next);
    }
  }finally{ heartbeatInFlight=false; heartbeatRequest=null; }
}

function startHeartbeat(){
  clearInterval(heartbeatTimer);
  heartbeatRoomMember().catch(console.error);
  heartbeatTimer = setInterval(()=>{heartbeatRoomMember().catch(console.error);},10000+Math.random()*1000);
}


function leaveRoomImmediately(){
  if(leaveSent || !configured || !roomId || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;
  leaveSent = true;

  const url = `${cfg.SUPABASE_URL}/rest/v1/rpc/leave_room_member`;

  try{
    fetch(url, {
      method:'POST',
      keepalive:true,
      headers:{
        'Content-Type':'application/json',
        'apikey':cfg.SUPABASE_ANON_KEY,
        'Authorization':`Bearer ${cfg.SUPABASE_ANON_KEY}`
      },
      body:JSON.stringify({
        p_room_id:roomId,
        p_client_id:myId
      })
    }).catch(()=>{});
  }catch(e){}
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
  if(historyLoading) return historyLoading;
  const targetRoom = roomId, generation = roomGeneration;
  const promise = (async()=>{
    let after = null;
    const rows = [], initialIds = new Set(cachedRows.map(r=>String(r.id)));
    for(;;){
      let query = supabaseClient.from('strokes')
        .select('id, client_id, layer_no, payload, created_at')
        .eq('room_id',targetRoom).order('id',{ascending:true}).limit(HISTORY_PAGE_SIZE);
      if(after !== null) query = query.gt('id',after);
      const {data,error} = await query;
      if(error) throw error;
      if(generation !== roomGeneration) return;
      rows.push(...(data || []));
      if(!data?.length || data.length < HISTORY_PAGE_SIZE) break;
      after = data[data.length-1].id;
    }
    if(generation !== roomGeneration) return;
    // Keep rows delivered/saved while the paginated snapshot was in flight.
    const byId = new Map(rows.map(r=>[String(r.id),r]));
    for(const row of cachedRows) if(!initialIds.has(String(row.id))) byId.set(String(row.id),row);
    cachedRows = [...byId.values()].filter(r=>!deletedRowIds.has(String(r.id)));
    for(const row of cachedRows){
      const id = row.payload?.segments?.[0]?.strokeId;
      if(id){ completedStrokeIds.add(id); remoteStrokeBuffers.delete(id); pendingCommits.delete(id); }
    }
    redrawFromCache();
    scheduleRemoteDraw();
  })();
  historyLoading = promise;
  try{ await promise; }finally{ if(historyLoading===promise) historyLoading=null; }
}

async function loadChatHistory(){
  if(!chatAtLatest) return;
  if(chatLoading) return chatLoading;
  const targetRoom=roomId, generation=roomGeneration;
  const promise=(async()=>{
    const {data,error} = await supabaseClient.from('chat_messages')
      .select('id, client_id, nickname, message, created_at').eq('room_id',targetRoom)
      .order('id',{ascending:false}).limit(MAX_CHAT_ROWS);
    if(error) throw error;
    if(generation !== roomGeneration) return;
    // Merge history with messages broadcast during the request.
    const live = [...chatMessagesEl.children].map(el=>el.chatRow).filter(Boolean);
    const rows = new Map([...(data||[]).reverse(),...live].map(r=>[String(r.id),r]));
    renderChat([...rows.values()].sort((a,b)=>Number(a.id)-Number(b.id)).slice(-MAX_CHAT_ROWS));
  })();
  chatLoading=promise;
  try{await promise;}finally{if(chatLoading===promise) chatLoading=null;}
}


async function persistStroke(segments, layerNo=activeLayer, targetRoom=roomId, generation=roomGeneration){
  if(!supabaseClient || !segments.length) return;

  const payload = {
    type:'stroke',
    segments
  };

  const { data, error } = await supabaseClient.rpc('save_room_stroke', {
    p_room_id: targetRoom,
    p_client_id: myId,
    p_layer_no: layerNo,
    p_payload: payload
  });

  if(error){
    console.error('save_room_stroke failed', error);
    showStatus('그림 저장 오류', true);
    return;
  }

  if(generation !== roomGeneration) return;
  pendingLocalStrokes.delete(segments[0].strokeId);
  cachedRows.push({
    id:data,
    room_id:targetRoom,
    client_id:myId,
    layer_no:layerNo,
    payload,
    created_at:new Date().toISOString()
  });

  completedStrokeIds.add(segments[0].strokeId);
  await broadcastCommittedStroke(segments,layerNo,data,generation);
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

  const rowIds = cachedRows.filter(r=>r.client_id===myId).map(r=>r.id);
  applyOwnerClear({ownerId:myId,rowIds});
  broadcast('owner_clear', { ownerId: myId, rowIds });
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

  applyOwnerUndo({ownerId:myId,strokeId:data});
  broadcast('owner_undo', { ownerId: myId, strokeId: data });
  showStatus('마지막 선 되돌림');
  setTimeout(()=>showStatus('실시간 연결됨'), 1000);
}


async function applyNicknameChange(nextName){
  const cleaned = (nextName || '').trim().slice(0,20);
  if(!cleaned) return;

  myName = cleaned;
  localStorage.setItem(NICKNAME_KEY, myName);
  updateRoomLabels();

  if(channel && channelReady){
    await channel.track({
      id:myId,
      name:myName,
      joined_at:new Date().toISOString()
    });
  }

  if(supabaseClient && roomId){
    await supabaseClient.rpc('touch_room_member', {
      p_room_id: roomId,
      p_client_id: myId,
      p_nickname: myName
    });
  }
}

nicknameBtn?.addEventListener('click', async ()=>{
  const next = prompt('새 닉네임을 입력해주세요. (최대 20자)', myName);
  if(next === null) return;
  await applyNicknameChange(next);
});

async function enterCurrentRoom(){
  roomGeneration++;
  const enteringGeneration=roomGeneration, enteringRoom=roomId;
  roomReady=false;
  leaveSent=false;
  historyLoading=null;
  chatLoading=null;
  cachedRows=[];
  resetTransientState();
  renderChat([]);
  showStatus('그림 불러오는 중…');
  if(roomMode !== 'public'){
    await ensureRoom();
    await registerPrivateRoomMember();
  }
  await connectRoomChannel();
  if(enteringRoom!==roomId || enteringGeneration!==roomGeneration) return;
  await Promise.all([loadRoomHistory(),loadChatHistory()]);
  if(enteringRoom!==roomId || enteringGeneration!==roomGeneration) return;
  roomReady=true;
  showStatus('실시간 연결됨');
  clearInterval(reconciliationTimer);
  reconciliationTimer=setInterval(()=>{
    if(channelReady && !document.hidden && !drawing){
      Promise.all([loadRoomHistory(),loadChatHistory()]).catch(console.error);
    }
  },60000+Math.random()*15000);
}

function applyOwnerClear(payload){
  if(payload.ownerId===myId) pendingLocalStrokes.clear();
  const ids=payload.rowIds && new Set(payload.rowIds.map(String));
  for(const row of cachedRows) if(row.client_id===payload.ownerId && (!ids || ids.has(String(row.id)))) deletedRowIds.add(String(row.id));
  cachedRows=cachedRows.filter(row=>row.client_id!==payload.ownerId || (ids && !ids.has(String(row.id))));
  redrawFromCache();
}
function applyOwnerUndo(payload){
  deletedRowIds.add(String(payload.strokeId));
  cachedRows=cachedRows.filter(row=>String(row.id)!==String(payload.strokeId));
  redrawFromCache();
}
function applyRoomExpiry(next){
  if(!Number.isFinite(next) || next <= expiresAt) return;
  expiresAt=next;
  roomGeneration++;
  historyLoading=null; chatLoading=null;
  resetTransientState(); clearCanvas(); cachedRows=[]; renderChat([]);
  kickVoteCounts.clear(); myKickVotes.clear();
  renderParticipants(currentPeople());
}


async function connectRoomChannel(){
  if(channel){
    try{ await supabaseClient.removeChannel(channel); }catch(e){}
  }

  channelReady = false;
  const connectedRoom=roomId;
  const roomChannel = supabaseClient.channel(`room:${roomId}`, {
    config:{
      broadcast:{self:false,ack:true},
      presence:{key:myId}
    }
  });

  channel=roomChannel;
  roomChannel
    .on('broadcast',{event:'stroke'}, ({payload}) => {
      if(roomChannel !== channel) return;
      // 이전 버전 클라이언트 호환
      if(payload.ownerId === myId) return;
      if(payload.segment){
        receiveRemoteStrokeBatch({
          ownerId:payload.ownerId,
          layerNo:payload.layerNo,
          segments:[payload.segment]
        });
      }
    })
    .on('broadcast',{event:'stroke_batch_v25'}, ({payload}) => {
      if(roomChannel !== channel) return;
      if(payload?.ownerId===myId || !Array.isArray(payload?.points) || payload.points.length>MAX_BATCH_SEGMENTS) return;
      receiveRemoteStrokeBatch({...payload,segments:unpackSegments(payload.points,payload.strokeId)});
    })
    .on('broadcast',{event:'stroke_batch'}, ({payload}) => {
      if(roomChannel !== channel) return;
      if(payload.ownerId === myId) return;
      receiveRemoteStrokeBatch(payload);
    })
    .on('broadcast',{event:'stroke_commit_v25'}, ({payload}) => {
      if(roomChannel !== channel) return;
      if(payload.ownerId===myId) return;
      receiveCommittedStroke(payload);
    })
    .on('broadcast',{event:'stroke_end'}, ({payload}) => {
      if(roomChannel !== channel) return;
      if(payload.ownerId === myId) return;
      finishRemoteStroke(payload);
    })
    .on('broadcast',{event:'owner_clear'}, ({payload}) => {
      if(roomChannel !== channel) return;
      applyOwnerClear(payload);
    })
    .on('broadcast',{event:'owner_undo'}, ({payload}) => {
      if(roomChannel !== channel) return;
      applyOwnerUndo(payload);
    })
    .on('broadcast',{event:'chat'}, ({payload}) => {
      if(roomChannel !== channel) return;
      appendChat(payload);
    })
    .on('broadcast',{event:'kick_vote'}, ({payload}) => {
      if(roomChannel !== channel) return;
      if(!payload?.targetId) return;

      kickVoteCounts.set(payload.targetId, Number(payload.voteCount || 0));

      if(payload.kicked && payload.targetId === myId){
        handleKickedFromRoom();
        return;
      }

      const people = Object.values(channel.presenceState()).flat();
      renderParticipants(people);
    })
    .on('broadcast',{event:'room_expired'}, ({payload}) => {
      if(roomChannel !== channel) return;
      if(roomChannel !== channel) return;
      applyRoomExpiry(Number(payload?.expiresAt));
    })
    .on('presence',{event:'sync'}, () => {
      if(roomChannel !== channel) return;
      const people=currentPeople();
      renderParticipants(people);
      if(roomOccupancy) roomOccupancy.textContent=String(people.length);
    });

  await new Promise((resolve,reject)=>{
    let subscribedOnce=false;
    const timeout=setTimeout(()=>reject(new Error('Realtime subscribe timeout')),15000);
    roomChannel.subscribe(async status=>{
      if(roomChannel !== channel || connectedRoom !== roomId) return;
      if(status==='SUBSCRIBED'){
        channelReady=true;
        clearTimeout(timeout);
        try{
          // Jitter prevents a simultaneous join storm from bursting Presence.
          await new Promise(r=>setTimeout(r,Math.random()*1200));
          if(roomChannel !== channel){reject(new Error('Room changed during subscribe'));return;}
          await roomChannel.track({id:myId,name:myName});
          startHeartbeat();
          if(subscribedOnce) await Promise.all([loadRoomHistory(),loadChatHistory()]);
          subscribedOnce=true;
          resolve();
        }catch(err){reject(err);showStatus('방 동기화 오류',true);}
      }else{
        channelReady=false;
        showStatus(status.toLowerCase());
        if(!subscribedOnce && (status==='CHANNEL_ERROR' || status==='TIMED_OUT' || status==='CLOSED')){
          clearTimeout(timeout);reject(new Error(status));
        }
      }
    });
  });
}


async function returnToLobby(){
  if(leavingRoom) return;
  leavingRoom=true;
  try{
  roomReady=false;
  finishStrokeImmediately(activePointerId);
  clearInterval(heartbeatTimer);
  clearInterval(reconciliationTimer);
  await mutationQueue;
  if(heartbeatRequest){try{await heartbeatRequest;}catch(e){}}
  channelReady=false;
  roomGeneration++;
  resetTransientState();
  cachedRows=[]; renderChat([]);
  if(!roomId){showLobby();return;}
  // 정상적인 버튼 이동이므로 keepalive에만 의존하지 않고
  // Supabase에서 현재 멤버를 즉시 제거.
  if(supabaseClient){
    try{
      await supabaseClient.rpc('leave_room_member', {
        p_room_id:roomId,
        p_client_id:myId
      });
    }catch(err){
      console.warn('leave room failed', err);
    }

    if(channel){
      try{
        await supabaseClient.removeChannel(channel);
      }catch(err){}
      channel = null;
    }
  }

  clearInterval(heartbeatTimer);
  heartbeatTimer = null;

  // 현재 방의 로컬 상태 정리
  drawing = false;
  activePointerId = null;
  currentStrokeSegments = [];
  networkSegmentBuffer = [];
  remoteStrokeBuffers?.clear?.();

  if(typeof clearCanvas === 'function'){
    clearCanvas();
  }

  roomId = null;
  roomMode = 'lobby';
  kickVoteCounts.clear();
  myKickVotes.clear();

  params.delete('room');
  params.delete('public');
  history.replaceState({}, '', location.pathname);

  updateRoomLabels();
  showStatus('공개방 선택 대기');
  showLobby();
  }finally{leavingRoom=false;}
}

brandHome?.addEventListener('click', ()=>{
  returnToLobby();
});

brandHome?.addEventListener('keydown', e=>{
  if(e.key === 'Enter' || e.key === ' '){
    e.preventDefault();
    returnToLobby();
  }
});


async function castKickVote(targetId, targetName, button){
  if(!supabaseClient || !roomId || !targetId || targetId === myId) return;
  if(myKickVotes.has(targetId)) return;

  button.disabled = true;
  button.textContent = '투표 중…';

  const { data, error } = await supabaseClient.rpc('cast_room_kick_vote', {
    p_room_id:roomId,
    p_voter_id:myId,
    p_target_id:targetId
  });

  if(error){
    console.error('cast_room_kick_vote failed', error);
    button.disabled = false;
    button.textContent = '추방 투표';
    showStatus('추방 투표 오류', true);
    return;
  }

  const result = typeof data === 'string' ? JSON.parse(data) : data;

  if(!result?.ok){
    button.disabled = Boolean(result?.already_voted);
    button.textContent = result?.already_voted ? '투표함' : '추방 투표';
    return;
  }

  myKickVotes.add(targetId);
  kickVoteCounts.set(targetId, Number(result.vote_count || 0));

  broadcast('kick_vote',{
    targetId,
    targetName,
    voteCount:Number(result.vote_count || 0),
    kicked:Boolean(result.kicked)
  });

  renderParticipants(Object.values(channel?.presenceState?.() || {}).flat());

  if(result.kicked){
    showStatus(`${targetName}님이 추방되었습니다.`);
    setTimeout(()=>showStatus('실시간 연결됨'),1200);
  }
}

async function handleKickedFromRoom(){
  if(kickedFromRoom) return;
  kickedFromRoom=true;
  try{
    await returnToLobby();
    showStatus('추방 투표 5표로 이 방에서 추방되었습니다.',true);
    lobbyMessage.textContent='추방된 방에는 이번 8분 동안 다시 들어갈 수 없어요.';
    lobbyMessage.classList.add('error');
  }finally{kickedFromRoom=false;}
}


async function setupRealtime(){
  if(!configured){
    showStatus('로컬 미리보기');
    renderParticipants([{id:myId,name:myName}]);
    renderChat([]);
    updateRoomLabels();
    return;
  }

  supabaseClient = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_ANON_KEY
  );

  try{
    if(!roomId){
      showStatus('공개방 선택 대기');
      showLobby();
      return;
    }

    // 고정 공개방 URL 직접 접속 시에도 30명 제한 검사
    if(FIXED_PUBLIC_ROOMS.includes(roomId)){
      const { data, error } = await supabaseClient.rpc('join_fixed_public_room', {
        p_room_id: roomId,
        p_client_id: myId,
        p_nickname: myName
      });

      if(error) throw error;

      const result = typeof data === 'string' ? JSON.parse(data) : data;

      if(!result?.ok){
        roomId = null;
        roomMode = 'lobby';
        params.delete('room');
        params.delete('public');
        history.replaceState({}, '', location.pathname);
        updateRoomLabels();
        showLobby();
        lobbyMessage.textContent =
          result?.reason === 'banned'
            ? '이 방에서 추방되어 이번 8분 동안 다시 들어갈 수 없어요.'
            : '그 방은 지금 30명이에요. 자리가 나면 다시 입장할 수 있어요.';
        lobbyMessage.classList.add('error');
        return;
      }

      expiresAt = new Date(result.expires_at).getTime();
    }

    await enterCurrentRoom();
  }catch(err){
    console.error('setupRealtime failed:', err);
    await returnToLobby();
    showStatus('방 연결 오류 — 새로고침해주세요', true);
  }
}

function renderParticipants(list){
  list=uniquePeople(list);
  participantCountEl.textContent = list.length;
  participantsEl.innerHTML = '';

  list.slice(0,30).forEach(p=>{
    const div = document.createElement('div');
    div.className='participant participant-with-action';
    div.dataset.participantId = p.id || '';

    const identity = document.createElement('div');
    identity.className = 'participant-identity';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = (p.name||'?').slice(-2);

    const name = document.createElement('span');
    name.textContent = p.name || 'guest';

    identity.appendChild(avatar);
    identity.appendChild(name);
    div.appendChild(identity);

    if(p.id && p.id !== myId && roomMode === 'public'){
      const action = document.createElement('button');
      action.className = 'kick-vote-btn';

      const count = kickVoteCounts.get(p.id) || 0;
      const voted = myKickVotes.has(p.id);

      action.textContent = voted
        ? `투표함 ${count}/5`
        : `추방 투표 ${count ? count + '/5' : ''}`;

      action.disabled = voted;
      action.addEventListener('click', ()=>{
        castKickVote(p.id, p.name || 'guest', action);
      });

      div.appendChild(action);
    }

    participantsEl.appendChild(div);
  });
}

function renderChat(rows){
  chatOlderBtn.disabled=!rows.length;
  chatLatestBtn.hidden=chatAtLatest;
  chatMessagesEl.innerHTML = '';
  chatIds.clear();
  if(!rows.length){
    const empty = document.createElement('div');
    empty.className = 'chat-empty';
    empty.textContent = '아직 메시지가 없어요 💬';
    chatMessagesEl.appendChild(empty);
    return;
  }
  rows.forEach(row=>appendChat(row,true));
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function appendChat(row,fromHistory=false){
  if(!chatAtLatest && !fromHistory){
    unreadChatCount++;
    chatLatestBtn.textContent=`최신 채팅 (${unreadChatCount})`;
    chatLatestBtn.hidden=false;
    return;
  }
  if(!row || (row.id != null && chatIds.has(String(row.id)))) return;
  if(row.id != null) chatIds.add(String(row.id));
  const existingEmpty = chatMessagesEl.querySelector('.chat-empty');
  if(existingEmpty) existingEmpty.remove();

  const div = document.createElement('div');
  div.chatRow=row;
  div.className = 'chat-msg' + (row.client_id === myId ? ' mine' : '');

  const name = document.createElement('b');
  name.textContent = row.nickname || 'guest';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = row.message || '';

  div.appendChild(name);
  div.appendChild(bubble);
  chatMessagesEl.appendChild(div);
  while(chatMessagesEl.children.length > MAX_CHAT_ROWS){
    const first=chatMessagesEl.firstElementChild;
    if(first.chatRow?.id != null) chatIds.delete(String(first.chatRow.id));
    first.remove();
  }
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

// Page older messages while keeping the visible DOM bounded.
chatOlderBtn.onclick=async()=>{
  if(!supabaseClient || !roomReady || chatPagingInFlight) return;
  const oldest=[...chatMessagesEl.children].find(el=>el.chatRow)?.chatRow?.id;
  if(oldest == null) return;
  chatPagingInFlight=true;
  chatOlderBtn.disabled=true;
  const generation=roomGeneration, targetRoom=roomId;
  try{
    const {data,error}=await supabaseClient.from('chat_messages')
      .select('id, client_id, nickname, message, created_at').eq('room_id',targetRoom)
      .lt('id',oldest).order('id',{ascending:false}).limit(MAX_CHAT_ROWS);
    if(error) throw error;
    if(generation!==roomGeneration) return;
    if(!data?.length){chatOlderBtn.disabled=true;return;}
    chatAtLatest=false;
    renderChat(data.reverse());
    chatLatestBtn.hidden=false;
    chatMessagesEl.scrollTop=0;
  }catch(err){console.error('older chat failed',err);showStatus('이전 채팅 조회 오류',true);chatOlderBtn.disabled=false;}
  finally{chatPagingInFlight=false;}
};
chatLatestBtn.onclick=async()=>{
  if(!supabaseClient || !roomReady || chatPagingInFlight) return;
  chatAtLatest=true;unreadChatCount=0;chatLatestBtn.textContent='최신 채팅';
  await loadChatHistory().catch(console.error);
};

async function sendChat(){
  const message = chatInput.value.trim();
  if(!message || !supabaseClient || !roomReady || chatSending) return;
  chatSending=true;
  const targetRoom=roomId, generation=roomGeneration;
  chatSendBtn.disabled = true;

  let result;
  try{result=await supabaseClient.rpc('send_room_chat', {
    p_room_id: targetRoom,
    p_client_id: myId,
    p_nickname: myName,
    p_message: message.slice(0,200)
  });}catch(error){result={error};}
  finally{chatSending=false;chatSendBtn.disabled=false;}
  if(generation !== roomGeneration) return;
  const {data,error}=result;

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

  if(chatInput.value.trim()===message) chatInput.value = '';

  const row = {
    id:data,
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

// Split exact final geometry below the Free-plan 256 KB payload limit.
function validSegment(s){
  return s && [s.x1,s.y1,s.x2,s.y2,s.width,s.opacity??1].every(Number.isFinite) &&
    s.width>0 && s.width<=200 && typeof s.color==='string' && s.color.length<=32 &&
    Math.abs(s.x1)<=WIDTH+200 && Math.abs(s.x2)<=WIDTH+200 &&
    Math.abs(s.y1)<=HEIGHT+200 && Math.abs(s.y2)<=HEIGHT+200;
}
function packSegments(segments){
  return segments.map(s=>[s.x1,s.y1,s.x2,s.y2,s.width,s.color,s.opacity,s.eraser]);
}
function unpackSegments(points,strokeId){
  return points.map(p=>({strokeId,x1:p[0],y1:p[1],x2:p[2],y2:p[3],width:p[4],color:p[5],opacity:p[6],eraser:p[7]}));
}
async function broadcastCommittedStroke(segments,layerNo,rowId,generation){
  const size=400, parts=Math.ceil(segments.length/size), strokeId=segments[0].strokeId;
  for(let part=0;part<parts;part++){
    if(generation!==roomGeneration) return;
    await broadcast('stroke_commit_v25',{ownerId:myId,layerNo,rowId,strokeId,part,parts,
      points:packSegments(segments.slice(part*size,(part+1)*size))});
    if(part+1<parts) await new Promise(r=>setTimeout(r,previewInterval()));
  }
}
function receiveCommittedStroke(payload){
  if(!payload?.strokeId || completedStrokeIds.has(payload.strokeId)) return;
  if(!Number.isInteger(payload.parts) || payload.parts<1 || payload.parts>10000 ||
     !Number.isInteger(payload.part) || payload.part<0 || payload.part>=payload.parts ||
     !Array.isArray(payload.points) || payload.points.length>400) return;
  let entry=pendingCommits.get(payload.strokeId);
  if(!entry){
    if(pendingCommits.size>=60) return;
    entry={chunks:new Map(),parts:payload.parts,updatedAt:Date.now()};
    pendingCommits.set(payload.strokeId,entry);
  }
  const decoded=unpackSegments(payload.points,payload.strokeId);
  if(!decoded.every(validSegment)) return;
  entry.chunks.set(payload.part,decoded);
  entry.updatedAt=Date.now();
  if(entry.chunks.size===entry.parts){
    const segments=[];
    for(let i=0;i<entry.parts;i++) segments.push(...entry.chunks.get(i));
    pendingCommits.delete(payload.strokeId);
    finishRemoteStroke({...payload,segments});
  }
}

function broadcast(event,payload={}){
  if(!channel || !channelReady) return Promise.resolve(false);
  const sendingChannel=channel;
  return Promise.resolve(sendingChannel.send({type:'broadcast',event,payload})).then(status=>{
    if(status !== 'ok' && sendingChannel===channel) showStatus('동기화 지연 — 저장된 그림은 재연결 시 복구됩니다',true);
    return status==='ok';
  }).catch(err=>{console.warn('broadcast failed',err);return false;});
}


let resettingRoom = false;

async function resetExpiredRoom(){
  if(resettingRoom || !roomId || !roomReady) return;
  resettingRoom=true;
  const generation=roomGeneration, targetRoom=roomId;
  try{
    if(!supabaseClient){applyRoomExpiry(Date.now()+ROOM_LIFETIME_MS);return;}
    const leader=currentPeople().map(p=>p.id).sort()[0];
    if(leader && leader!==myId) await new Promise(r=>setTimeout(r,1500+Math.random()*1500));
    if(generation!==roomGeneration || expiresAt>Date.now()) return;
    const {data,error}=await supabaseClient.rpc('reset_room_if_expired_v25',{
      p_room_id:targetRoom,p_room_type:roomMode==='public'?'public':'private'
    });
    if(error) throw error;
    if(generation!==roomGeneration) return;
    const next=new Date(data.expires_at).getTime();
    applyRoomExpiry(next);
    if(data.did_reset) broadcast('room_expired',{expiresAt:next});
  }catch(err){console.error('room reset failed',err);showStatus('방 초기화 오류',true);}
  finally{resettingRoom=false;}
}


function updateCountdown(){
  if(!roomId){expiryCountdown.textContent='08:00';return;}
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



function isInsideCanvasPoint(p){
  return p.x >= 0 && p.x <= WIDTH && p.y >= 0 && p.y <= HEIGHT;
}


function queueNetworkSegment(seg){
  networkSegmentBuffer.push(seg);

  if(networkFlushTimer !== null) return;

  networkFlushTimer = window.setTimeout(()=>{
    flushNetworkSegments();
  }, previewInterval());
}

function flushNetworkSegments(){
  if(networkFlushTimer !== null){
    clearTimeout(networkFlushTimer);
    networkFlushTimer = null;
  }

  if(!networkSegmentBuffer.length) return;

  const segments = networkSegmentBuffer.splice(0, MAX_BATCH_SEGMENTS);

  broadcast('stroke_batch_v25',{
    ownerId:myId,
    layerNo:strokeLayer,
    strokeId:segments[0].strokeId,
    points:packSegments(segments)
  });
  if(networkSegmentBuffer.length){
    networkFlushTimer=setTimeout(flushNetworkSegments,previewInterval());
  }
}

function emitDrawPoint(rawPoint){
  if(!isInsideCanvasPoint(rawPoint)) return;

  const now = performance.now();
  const dt = lastInputTime ? Math.max(1, now - lastInputTime) : 16;
  lastInputTime = now;

  const p = smooth(rawPoint);

  if(!lastPoint){
    lastPoint = p;
    return;
  }

  const distance = Math.hypot(p.x-lastPoint.x, p.y-lastPoint.y);
  const speed = distance / dt; // canvas px per millisecond

  // 비정상적인 순간 좌표 튐 제거:
  // 아주 짧은 시간에 큰 거리가 순간이동한 경우만 버림.
  const impossibleJump =
    (dt <= 8 && distance > 55) ||
    (dt <= 16 && distance > 110) ||
    speed > 9.5 ||
    distance > 240;

  if(impossibleJump){
    rejectedJumpCount++;
    smoothPoint = {...rawPoint};
    lastPoint = {...rawPoint};
    return;
  }

  const seg = {
    strokeId:currentStrokeId,
    x1:lastPoint.x,
    y1:lastPoint.y,
    x2:p.x,
    y2:p.y,
    width:getStyledWidth(p.pressure),
    color:colorInput.value,
    opacity:currentStrokeOpacity,
    eraser:currentStrokeIsEraser
  };

  // 로컬 한 획은 liveCanvas에서 다시 그린다.
  // 반투명 조각들이 서로 겹치지 않도록 전체 획을 한 번에 표시.
  currentStrokeSegments.push(seg);
  drawOpaqueSegment(liveCtx,seg);
  queueNetworkSegment(seg);

  lastPoint = p;
}

let lastPoint = null;

canvas.addEventListener('pointerdown', e=>{
  if(configured && (!roomReady || !channelReady || resettingRoom)) return;
  if(e.pointerType === 'mouse' && e.button !== 0) return;
  if(spaceDown || tool==='hand'){
    panning = true;
    panStart = {x:e.clientX-pan.x,y:e.clientY-pan.y};
    canvas.style.cursor='grabbing';
    return;
  }

  // 이미 다른 포인터가 그리는 중이면 무시
  if(activePointerId !== null) return;

  activePointerId = e.pointerId;
  drawing = true;
  smoothPoint = null;
  networkSegmentBuffer = [];
  if(networkFlushTimer !== null){
    clearTimeout(networkFlushTimer);
    networkFlushTimer = null;
  }
  strokeLayer=activeLayer;
  strokeGeneration=roomGeneration;
  currentStrokeId = crypto.randomUUID();
  currentStrokeSegments = [];
  currentStrokeOpacity = tool === 'eraser' ? 1 : Number(opacityInput.value)/100;
  currentStrokeIsEraser = tool === 'eraser';
  liveCtx.clearRect(0,0,WIDTH,HEIGHT);
  liveCanvas.style.opacity = String(currentStrokeOpacity);

  const start = canvasPointFromEvent(e);
  if(!isInsideCanvasPoint(start)){
    drawing = false;
    activePointerId = null;
    return;
  }

  smoothPoint = {...start};
  lastPoint = {...start};
  lastInputTime = performance.now();

  canvas.setPointerCapture?.(e.pointerId);
});




function handleDrawMove(e){
  if(panning && panStart){
    pan.x = e.clientX-panStart.x;
    pan.y = e.clientY-panStart.y;
    updateTransform();
    return;
  }

  if(!drawing || e.pointerId !== activePointerId) return;

  // 마우스/펜은 손을 뗀 뒤 hover pointermove가 계속 들어올 수 있음.
  // buttons=0이면 더 이상 실제로 누르고 있는 상태가 아니므로 즉시 종료.
  if((e.pointerType === 'mouse' || e.pointerType === 'pen') && e.buttons === 0){
    finishStrokeImmediately(e.pointerId);
    return;
  }

  e.preventDefault();

  const p = canvasPointFromEvent(e);
  if(!isInsideCanvasPoint(p)) return;

  emitDrawPoint(p);
}

// 안정성을 위해 pointermove만 사용.
canvas.addEventListener('pointermove', handleDrawMove, {passive:false});


async function saveFinishedStroke(segments,layerNo,targetRoom,generation){
  if(!segments?.length) return;
  return enqueueMutation(()=>{
    if(generation !== roomGeneration) return;
    return persistStroke(segments,layerNo,targetRoom,generation);
  });
}


function finishStrokeImmediately(pointerId){
  if(activePointerId === null) return;
  if(pointerId !== undefined && pointerId !== null && pointerId !== activePointerId) return;

  const segmentsToSave = currentStrokeSegments.slice();
  if(segmentsToSave.length && supabaseClient){
    pendingLocalStrokes.set(segmentsToSave[0].strokeId,{client_id:myId,layer_no:strokeLayer,payload:{type:'stroke',segments:segmentsToSave}});
  }

  // 손을 떼는 순간 현재 live 획을 메인 캔버스에 단 한 번 합성.
  if(segmentsToSave.length){
    ctx.save();
    ctx.globalAlpha = currentStrokeIsEraser ? 1 : currentStrokeOpacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(liveCanvas,0,0);
    ctx.restore();
  }

  liveCtx.clearRect(0,0,WIDTH,HEIGHT);
  liveCanvas.style.opacity = '1';

  drawing = false;
  activePointerId = null;
  panning = false;
  panStart = null;
  smoothPoint = null;
  lastPoint = null;
  lastInputTime = 0;

  if(networkFlushTimer !== null) clearTimeout(networkFlushTimer);
  networkFlushTimer=null;
  networkSegmentBuffer=[];
  currentStrokeSegments = [];

  canvas.style.cursor=(tool==='hand'||spaceDown)?'grab':'crosshair';

  if(segmentsToSave.length){
    saveFinishedStroke(segmentsToSave,strokeLayer,roomId,strokeGeneration);
  }
}

window.addEventListener('pointerup', e=>{
  finishStrokeImmediately(e.pointerId);
});



function currentToolSize(){
  return tool === 'eraser' ? eraserSize : brushSize;
}

function toolPresetValues(){
  return tool === 'eraser'
    ? [20,30,40,50,60]
    : [1,5,10,15,20];
}

function renderSizePresets(){
  const values = toolPresetValues();
  const buttons = [...document.querySelectorAll('[data-size-preset]')];

  buttons.forEach((btn,index)=>{
    const value = values[index];
    btn.dataset.sizePreset = String(value);

    const dot = btn.querySelector('span');
    const label = btn.querySelector('b');

    if(dot){
      const preview = tool === 'eraser'
        ? Math.min(22, Math.max(7, value * .34))
        : Math.min(22, Math.max(4, value));
      dot.style.setProperty('--s', `${preview}px`);
    }

    if(label) label.textContent = String(value);
  });

  updateSizePresetActive();
}

function updateSizePresetActive(){
  document.querySelectorAll('[data-size-preset]').forEach(btn=>{
    btn.classList.toggle(
      'active',
      Number(btn.dataset.sizePreset) === currentToolSize()
    );
  });
}

function syncToolSettingsUI(){
  const isEraser = tool === 'eraser';

  toolSettingsTitle.textContent = isEraser ? '지우개' : '브러시';

  brushOnlySettings?.classList.toggle('tool-settings-hidden', isEraser);
  brushExtraSettings?.classList.toggle('tool-settings-hidden', isEraser);

  const value = currentToolSize();
  sizeInput.value = String(value);
  sizeValue.textContent = String(value);

  renderSizePresets();
  updateBrushCursorSize();
}

document.querySelectorAll('[data-size-preset]').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const value = Number(btn.dataset.sizePreset);

    if(tool === 'eraser') eraserSize = value;
    else brushSize = value;

    sizeInput.value = String(value);
    sizeValue.textContent = String(value);

    updateSizePresetActive();
    updateBrushCursorSize();
  });
});

document.querySelectorAll('.tool').forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll('.tool').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    tool=btn.dataset.tool;
    liveCtx.clearRect(0,0,WIDTH,HEIGHT);
    syncToolSettingsUI();
  };
});

document.querySelectorAll('.brush-type').forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll('.brush-type').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    brushType=btn.dataset.brushType;
  };
});

sizeInput.oninput=()=>{
  const value = Number(sizeInput.value);

  if(tool === 'eraser') eraserSize = value;
  else brushSize = value;

  sizeValue.textContent = String(value);
  updateSizePresetActive();
  updateBrushCursorSize();
};

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
  if(configured && !roomReady) return;
  finishStrokeImmediately(activePointerId);
  await enqueueMutation(deleteMyDrawings);
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
  liveCtx?.clearRect?.(0,0,WIDTH,HEIGHT);
  syncToolSettingsUI();
}

function changeBrushSize(delta){
  const min = Number(sizeInput.min) || 1;
  const max = Number(sizeInput.max) || 80;
  const next = Math.max(min, Math.min(max, currentToolSize() + delta));

  if(tool === 'eraser') eraserSize = next;
  else brushSize = next;

  sizeInput.value = String(next);
  sizeValue.textContent = String(next);

  updateSizePresetActive();
  updateBrushCursorSize();
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
    if(configured && !roomReady) return;
    finishStrokeImmediately(activePointerId);
    await enqueueMutation(undoMyLastStroke);
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


window.addEventListener('pointercancel', e=>{
  finishStrokeImmediately(e.pointerId);
  liveCtx.clearRect(0,0,WIDTH,HEIGHT);
});


// 탭 닫기/페이지 이동 시 DB의 방 인원에서도 즉시 제거
window.addEventListener('pagehide', ()=>{
  clearInterval(heartbeatTimer);
  clearInterval(reconciliationTimer);
  leaveRoomImmediately();
});

window.addEventListener('beforeunload', ()=>{
  leaveRoomImmediately();
});


canvas.addEventListener('lostpointercapture', e=>{
  finishStrokeImmediately(e.pointerId);
});

window.addEventListener('blur', ()=>{
  // 창 포커스를 잃었을 때도 선이 붙잡힌 채 남지 않도록 종료
  finishStrokeImmediately(activePointerId);
});


viewport.addEventListener('pointermove', e=>{
  moveBrushCursor(e);
});

viewport.addEventListener('pointerenter', e=>{
  moveBrushCursor(e);
});

viewport.addEventListener('pointerleave', ()=>{
  hideBrushCursor();
});

canvas.addEventListener('pointerdown', e=>{
  moveBrushCursor(e);
});

window.addEventListener('resize', ()=>{
  updateBrushCursorSize();
});

sizeValue.textContent = sizeInput.value;
updateBrushCursorSize();

// Initial tool size UI
syncToolSettingsUI();

window.addEventListener('pageshow',e=>{
  if(e.persisted && configured) location.reload();
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden) finishStrokeImmediately(activePointerId);
  else if(roomId && channelReady){
    heartbeatRoomMember().catch(console.error);
    Promise.all([loadRoomHistory(),loadChatHistory()]).catch(console.error);
  }else if(!roomId && supabaseClient) fetchFixedRoomCounts().catch(console.error);
});
