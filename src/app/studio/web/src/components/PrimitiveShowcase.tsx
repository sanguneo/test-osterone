import { Icon } from "./Icon";
import { VerdictMark } from "./Verdict";

export function PrimitiveShowcase() {
	return (
		<main className="showcase-shell">
			<header className="showcase-head">
				<div className="brand-lockup">
					<span className="brand-mark" aria-hidden="true">t</span>
					<span><b>test-osterone</b><small>primitive showcase</small></span>
				</div>
				<a className="text-link" href="/">Studio 열기</a>
			</header>

			<section className="showcase-section" aria-labelledby="showcase-actions">
				<div className="section-heading">
					<div><p className="kicker">Components</p><h1 id="showcase-actions">행동과 상태</h1></div>
					<p>기본, hover, focus, disabled 상태가 동일한 토큰과 아이콘 체계를 공유합니다.</p>
				</div>
				<div className="showcase-row">
					<button className="button primary" type="button"><Icon name="play" /> 실행 시작</button>
					<button className="button secondary" type="button"><Icon name="edit" /> 편집</button>
					<button className="button destructive" type="button"><Icon name="trash" /> 삭제</button>
					<button className="button secondary" type="button" disabled>사용 불가</button>
					<button className="icon-button" type="button" aria-label="닫기"><Icon name="close" /></button>
				</div>
				<div className="showcase-row verdict-row">
					<VerdictMark verdict="pass" />
					<VerdictMark verdict="fail" />
					<VerdictMark verdict="needs_review" />
					<VerdictMark verdict="error" />
				</div>
			</section>

			<section className="showcase-section" aria-labelledby="showcase-nav">
				<div className="section-heading compact"><div><p className="kicker">Wayfinding</p><h2 id="showcase-nav">내비게이션과 컨텍스트</h2></div></div>
				<nav className="primary-nav showcase-nav" aria-label="쇼케이스 내비게이션">
					<button className="nav-item active" type="button" aria-current="page"><Icon name="overview" /><span>대시보드</span></button>
					<button className="nav-item" type="button"><Icon name="rules" /><span>규칙·해석</span></button>
					<button className="nav-item" type="button"><Icon name="play" /><span>실행</span></button>
					<button className="nav-item" type="button"><Icon name="review" /><span>리뷰 큐</span><b className="nav-count">3</b></button>
				</nav>
				<div className="context-lane">
					<span className="context-label"><Icon name="project" />프로젝트</span>
					<div className="context-reel">
						<button className="context-item selected" type="button" aria-pressed="true">샘플 회귀</button>
						<button className="context-item" type="button" aria-pressed="false">결제 스모크</button>
					</div>
					<button className="icon-button quiet" type="button" aria-label="프로젝트 추가"><Icon name="add" /></button>
				</div>
			</section>

			<section className="showcase-section" aria-labelledby="showcase-rail">
				<div className="section-heading compact"><div><p className="kicker">Signature</p><h2 id="showcase-rail">Run rail</h2></div></div>
				<ol className="run-rail">
					<li className="rail-step complete"><span className="rail-node"><Icon name="check" size={15} /></span><div><b>케이스 준비</b><p>시트 1개에서 12개 케이스를 읽었습니다.</p></div></li>
					<li className="rail-step active"><span className="rail-node">2</span><div><b>브라우저 실행</b><p>규칙 해석으로 staging 환경을 확인합니다.</p></div></li>
					<li className="rail-step"><span className="rail-node">3</span><div><b>증거 검토</b><p>보류된 판정만 사람이 확인합니다.</p></div></li>
				</ol>
			</section>
		</main>
	);
}
