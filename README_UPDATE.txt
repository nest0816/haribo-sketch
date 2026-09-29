HARIBO SKETCH v9 — 채팅 + 개인 레이어 3개

추가된 기능
- 같은 방 채팅
- 늦게 들어온 사람도 이전 채팅 확인
- 각 사용자 개인 레이어 최대 3개
- 레이어 선택
- 내 레이어별 보이기/숨기기
- 내 그림 지우기는 내 모든 레이어만 삭제
- 8분 후 그림 + 채팅 모두 자동 삭제
- 늦게 들어온 사람도 기존 그림 보임

중요
config.js는 절대로 바꾸거나 덮어쓰지 마세요.
현재 Project URL과 Publishable Key가 들어 있으므로 그대로 둡니다.

[1] Supabase
1. haribo-sketch 프로젝트
2. 왼쪽 SQL Editor
3. New query
4. 이 폴더의 supabase.sql 내용을 전부 복사
5. 붙여넣기
6. RUN

[2] GitHub
기존 저장소에서 아래 3개 파일을 새 버전으로 교체:
- index.html
- style.css
- app.js

config.js는 그대로 둡니다.

가장 쉬운 방법:
1. GitHub haribo-sketch 저장소 접속
2. index.html 클릭 → ... → Delete file → Commit changes
3. style.css도 같은 방식으로 삭제
4. app.js도 같은 방식으로 삭제
5. 저장소 첫 화면에서 Add file → Upload files
6. 이번 압축파일의 index.html / style.css / app.js 3개만 올림
7. Commit changes

[3] Vercel
GitHub 변경 후 Vercel이 자동으로 다시 배포합니다.
1~2분 정도 기다린 뒤 사이트에서 Ctrl + Shift + R

[4] 테스트
A와 B가 같은 방 링크 접속
- 둘 다 채팅 가능
- A가 레이어 2를 추가하고 그림
- B 그림은 그대로 보임
- A가 레이어 2 눈 버튼을 누르면 A 화면에서만 그 레이어 숨김
- A가 내 그림 지우기를 누르면 A 그림만 모두 삭제
- 새 사람 C가 들어와도 현재 그림/채팅이 보임
- 8분이 끝나면 그림과 채팅이 모두 사라짐
