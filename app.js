
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

const lobbyOverlay = document.getElementById('lobbyOverlay');
const lobbyNickname = document.getElementById('lobbyNickname');
const lobbyMessage = document.getElementById('lobbyMessage');
const nicknameBtn = document.getElementById('nicknameBtn');
const myNicknameEl = document.getElementById('myNickname');


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
let activePointerId = null;
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
  const amount = Number(smoothingInput.value) / 100;

  if(!smoothPoint){
    smoothPoint = {...raw};
    return {...raw};
  }

  // 초반 버전 느낌에 가깝게:
  // 보정은 가볍게만 적용하고 손 위치를 크게 뒤쫓지 않음.
  const alpha = 1 - (amount * 0.55);

  smoothPoint = {
    x: smoothPoint.x + (raw.x - smoothPoint.x) * alpha,
    y: smoothPoint.y + (raw.y - smoothPoint.y) * alpha,
    pressure: raw.pressure
  };

  return {...smoothPoint};
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
let lobbyRefreshTimer = null;

async function fetchFixedRoomCounts(){
  if(!supabaseClient) return;

  const { data, error } = await supabaseClient.rpc('fixed_public_room_counts');

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
    lobbyMessage.textContent = result?.reason === 'full'
      ? '이 방은 지금 30명이에요. 자리가 나면 다시 입장할 수 있어요.'
      : '지금은 입장할 수 없어요.';
    lobbyMessage.classList.add('error');
    await fetchFixedRoomCounts();
    return false;
  }

  roomId = targetRoomId;
  roomMode = 'public';
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
      fetchFixedRoomCounts();
    }
  }, 1000);
}

document.querySelectorAll('.public-room-choice').forEach(btn=>{
  btn.addEventListener('click', async ()=>{
    if(btn.disabled) return;
    const ok = await joinFixedPublicRoom(btn.dataset.fixedRoom);
    if(ok){
      await enterCurrentRoom();
    }
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
  }, 3000);
}

function leaveRoomImmediately(){
  if(!configured || !roomId || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) return;

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


async function applyNicknameChange(nextName){
  const cleaned = (nextName || '').trim().slice(0,20);
  if(!cleaned) return;

  myName = cleaned;
  localStorage.setItem(NICKNAME_KEY, myName);
  updateRoomLabels();

  if(channel){
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
  showStatus('그림 불러오는 중…');

  await ensureRoom();
  await registerPrivateRoomMember();
  await Promise.all([loadRoomHistory(), loadChatHistory()]);
  await connectRoomChannel();
}

async function connectRoomChannel(){
  if(channel){
    try{ await supabaseClient.removeChannel(channel); }catch(e){}
  }

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
    }else{
      showStatus(status.toLowerCase());
    }
  });
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
        lobbyMessage.textContent = '그 방은 지금 30명이에요. 자리가 나면 다시 입장할 수 있어요.';
        lobbyMessage.classList.add('error');
        return;
      }

      expiresAt = new Date(result.expires_at).getTime();
    }

    await enterCurrentRoom();
  }catch(err){
    console.error('setupRealtime failed:', err);
    showStatus('방 연결 오류 — 새로고침해주세요', true);
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



function isInsideCanvasPoint(p){
  return p.x >= 0 && p.x <= WIDTH && p.y >= 0 && p.y <= HEIGHT;
}

function emitDrawPoint(rawPoint){
  if(!isInsideCanvasPoint(rawPoint)) return;

  const p = smooth(rawPoint);

  if(!lastPoint){
    lastPoint = p;
    return;
  }

  const dx = p.x - lastPoint.x;
  const dy = p.y - lastPoint.y;
  const distance = Math.hypot(dx, dy);

  // 브라우저 좌표가 비정상적으로 크게 튈 때만 연결 끊기
  if(distance > 180){
    smoothPoint = {...rawPoint};
    lastPoint = {...rawPoint};
    return;
  }

  const seg = {
    strokeId: currentStrokeId,
    x1: lastPoint.x,
    y1: lastPoint.y,
    x2: p.x,
    y2: p.y,
    width: getStyledWidth(p.pressure),
    color: colorInput.value,
    opacity: Number(opacityInput.value) / 100,
    eraser: tool === 'eraser'
  };

  drawSegment(seg);

  broadcast('stroke',{
    ownerId: myId,
    layerNo: activeLayer,
    segment: seg
  });

  currentStrokeSegments.push(seg);
  lastPoint = p;
}

let lastPoint = null;

canvas.addEventListener('pointerdown', e=>{
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
  currentStrokeId = crypto.randomUUID();
  currentStrokeSegments = [];

  const start = canvasPointFromEvent(e);
  if(!isInsideCanvasPoint(start)){
    drawing = false;
    activePointerId = null;
    return;
  }

  smoothPoint = {...start};
  lastPoint = {...start};

  canvas.setPointerCapture?.(e.pointerId);
});

canvas.addEventListener('pointermove', e=>{
  if(panning && panStart){
    pan.x = e.clientX-panStart.x;
    pan.y = e.clientY-panStart.y;
    updateTransform();
    return;
  }

  if(!drawing || e.pointerId !== activePointerId) return;

  const p = canvasPointFromEvent(e);
  if(!isInsideCanvasPoint(p)) return;

  emitDrawPoint(p);
});

window.addEventListener('pointerup', async e=>{
  if(e.pointerId !== activePointerId){
    panning=false;
    panStart=null;
    return;
  }

  if(drawing){
    if(currentStrokeSegments.length === 0 && lastPoint){
      const seg = {
        strokeId: currentStrokeId,
        x1: lastPoint.x - 0.01,
        y1: lastPoint.y,
        x2: lastPoint.x + 0.01,
        y2: lastPoint.y,
        width: getStyledWidth(lastPoint.pressure),
        color: colorInput.value,
        opacity: Number(opacityInput.value) / 100,
        eraser: tool === 'eraser'
      };

      drawSegment(seg);
      broadcast('stroke',{
        ownerId:myId,
        layerNo:activeLayer,
        segment:seg
      });
      currentStrokeSegments.push(seg);
    }

    if(currentStrokeSegments.length){
      const toSave = currentStrokeSegments.slice();
      currentStrokeSegments = [];
      await persistStroke(toSave);
    }
  }

  drawing=false;
  activePointerId=null;
  panning=false;
  panStart=null;
  smoothPoint=null;
  lastPoint=null;
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


window.addEventListener('pointercancel', e=>{
  if(e.pointerId !== activePointerId) return;
  drawing = false;
  activePointerId = null;
  currentStrokeSegments = [];
  smoothPoint = null;
  lastPoint = null;
});


// 탭 닫기/페이지 이동 시 DB의 방 인원에서도 즉시 제거
window.addEventListener('pagehide', ()=>{
  leaveRoomImmediately();
});

window.addEventListener('beforeunload', ()=>{
  leaveRoomImmediately();
});
