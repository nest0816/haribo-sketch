# Haribo Sketch Live v6 ✨

**8분 동안만 존재하는 다중접속 그림방** 프로토타입입니다.

## 핵심 기능
- 같은 `?room=방코드` 링크로 들어오면 같은 실시간 방에 접속
- 여러 사람이 동시에 선을 그리면 즉시 서로에게 반영
- 접속자 수 / 닉네임 표시
- 방 링크 복사
- 일반 브러시 / 필압 브러시
- 손떨림 보정
- 투명도
- 지우개 / 전체 지우기
- 8분 카운트다운
- 00:00이 되면 알림 없이 캔버스 즉시 삭제
- PNG 저장

## 바로 실행하면?
Supabase 설정값이 비어 있으면 **로컬 미리보기 모드**로 실행됩니다.
그림 기능과 8분 타이머는 동작하지만 다른 사람과 동기화되지는 않습니다.

## 진짜 다중접속 활성화

1. https://supabase.com 에서 무료 프로젝트를 하나 만듭니다.
2. Project Settings → API에서 아래 두 값을 확인합니다.
   - Project URL
   - anon public key
3. `config.js`를 열고 값을 넣습니다.

```js
window.HARIBO_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_ANON_KEY"
};
```

4. 파일들을 Netlify / Vercel / GitHub Pages 등에 올립니다.
5. 생성된 사이트 주소를 열고 `방 링크 복사` 버튼으로 친구들에게 공유합니다.

예시:
`https://example.com/?room=abc123`

같은 주소로 들어온 사람들은 같은 실시간 채널에 접속합니다.

## 중요한 현재 한계
현재 버전은 **실시간 선 이벤트를 Broadcast로 주고받는 방식**이라,
늦게 들어온 사용자는 입장 이전의 선을 자동으로 복원하지 않습니다.

다음 버전에서 Supabase DB에 8분 동안만 stroke history를 저장하도록 만들면,
중간에 들어온 사용자도 기존 그림을 즉시 볼 수 있고 8분 뒤 DB 기록까지 삭제할 수 있습니다.

## 추천 다음 단계
- 방 생성 시 서버 기준 `expires_at` 저장
- 최근 8분 stroke history 저장
- 중간 입장자 캔버스 복원
- 서버에서 만료 룸 자동 삭제
- 랜덤 닉네임 / 색상
- 사용자별 실시간 커서
- 채팅
- 레이어
