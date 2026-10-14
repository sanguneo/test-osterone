# 데모 로그인 화면 기획서

대상: `src/testing/fixture-app.ts` — 테스트 자동화 데모용 단일 페이지 로그인 화면.

## 1. 화면 구성

| 요소 | 라벨 / 문구 | 비고 |
| --- | --- | --- |
| 제목 | Sign in | 페이지 진입 시 항상 표시 |
| 아이디 입력란 | Username | placeholder 동일 |
| 비밀번호 입력란 | Password | 입력값 마스킹 |
| 로그인 버튼 | Log in | |
| 결과 영역 | (상태 메시지) | role=status |

## 2. 기능 요구사항

- FR-1 올바른 계정(아이디 `admin`, 비밀번호 `secret`)으로 로그인하면 결과 영역에 `Welcome, admin. Dashboard loaded.` 를 표시한다.
- FR-2 비밀번호가 틀리면 결과 영역에 `Invalid credentials. Please try again.` 를 표시한다.
- FR-3 아이디가 틀린 경우도 FR-2와 같은 메시지를 표시한다 (계정 존재 여부를 노출하지 않는다).
- FR-4 아무것도 입력하지 않고 로그인하면 FR-2와 같은 메시지를 표시한다.
- FR-5 로그인에 실패해도 제목 `Sign in` 과 입력란은 그대로 남아 다시 시도할 수 있다.

## 3. 범위 밖

- 회원가입, 비밀번호 찾기, 세션 유지, 로그아웃은 이 화면에 없다.
