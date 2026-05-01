import React from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  interpolate,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import "./style.css";

const ease = Easing.bezier(0.16, 1, 0.3, 1);

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const appear = (frame: number, start: number, duration = 32) =>
  interpolate(frame, [start, start + duration], [0, 1], {
    ...clamp,
    easing: ease,
  });

const disappear = (frame: number, start: number, duration = 24) =>
  interpolate(frame, [start, start + duration], [1, 0], {
    ...clamp,
    easing: Easing.in(Easing.cubic),
  });

const life = (frame: number, start: number, end: number) =>
  appear(frame, start) * disappear(frame, end);

const useScene = (start: number, end: number) => {
  const frame = useCurrentFrame();
  const local = frame - start;
  const visible = life(frame, start, end);
  return { frame, local, visible };
};

const Backdrop = () => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, 540], [-60, 70], clamp);
  const glow = interpolate(frame, [0, 160, 360, 540], [0.55, 0.9, 0.7, 1], clamp);

  return (
    <AbsoluteFill className="backdrop">
      <div className="grain" />
      <div
        className="halo halo-a"
        style={{
          opacity: glow,
          transform: `translate(${drift}px, ${drift * 0.25}px)`,
        }}
      />
      <div
        className="halo halo-b"
        style={{
          transform: `translate(${-drift * 0.55}px, ${drift * 0.2}px)`,
        }}
      />
      <div className="grid" />
    </AbsoluteFill>
  );
};

const LogoMark = ({ progress, compact = false }: { progress: number; compact?: boolean }) => {
  const size = compact ? 190 : 250;
  return (
    <div
      className="logoWrap"
      style={{
        width: size,
        height: size,
        opacity: progress,
        transform: `scale(${interpolate(progress, [0, 1], [0.84, 1])}) translateY(${interpolate(
          progress,
          [0, 1],
          [30, 0],
        )}px)`,
      }}
    >
      <Img src={staticFile("vibe-editor.png")} className="logoImg" />
      <div className="logoPulse" />
    </div>
  );
};

const HeroScene = () => {
  const { frame, visible } = useScene(0, 140);
  const p = appear(frame, 8, 46);
  const title = appear(frame, 28, 34);
  const subtitle = appear(frame, 54, 28);
  const orbit = interpolate(frame, [0, 140], [0, 1], clamp);

  return (
    <AbsoluteFill
      className="scene hero"
      style={{ opacity: visible, transform: `scale(${interpolate(visible, [0, 1], [0.985, 1])})` }}
    >
      <div className="heroOrbits" style={{ transform: `rotate(${orbit * 18}deg)` }}>
        <span />
        <span />
        <span />
      </div>
      <LogoMark progress={p} />
      <div className="heroText" style={{ opacity: title }}>
        <div className="eyebrow">AI team orchestrator</div>
        <h1>vibe-editor</h1>
      </div>
      <p
        className="heroCopy"
        style={{
          opacity: subtitle,
          transform: `translateY(${interpolate(subtitle, [0, 1], [28, 0])}px)`,
        }}
      >
        Claude Code と Codex を、ひとつのデスクトップで束ねる。
      </p>
    </AbsoluteFill>
  );
};

const AgentNode = ({
  label,
  role,
  x,
  y,
  delay,
}: {
  label: string;
  role: string;
  x: number;
  y: number;
  delay: number;
}) => {
  const frame = useCurrentFrame();
  const p = appear(frame, 126 + delay, 24);
  return (
    <div
      className="agentNode"
      style={{
        left: x,
        top: y,
        opacity: p,
        transform: `translate(-50%, -50%) scale(${interpolate(p, [0, 1], [0.72, 1])})`,
      }}
    >
      <strong>{label}</strong>
      <span>{role}</span>
    </div>
  );
};

const TeamScene = () => {
  const { frame, visible } = useScene(112, 284);
  const local = frame - 112;
  const leader = appear(frame, 124, 30);
  const lineProgress = appear(frame, 148, 48);

  return (
    <AbsoluteFill className="scene team" style={{ opacity: visible }}>
      <div className="sectionText leftText">
        <div className="eyebrow">2 to 30 agents</div>
        <h2>チームを作って、仕事を流す。</h2>
        <p>leader / programmer / researcher / reviewer が、同じ画面でリアルタイムに連携。</p>
      </div>
      <svg className="teamLines" viewBox="0 0 1920 1080">
        {[
          "M960 520 C810 410 720 365 650 405",
          "M960 520 C805 590 720 680 635 790",
          "M960 520 C1125 365 1290 310 1460 365",
          "M960 520 C1135 590 1315 690 1495 780",
        ].map((d) => (
          <path
            key={d}
            d={d}
            pathLength={1}
            style={{
              strokeDasharray: 1,
              strokeDashoffset: 1 - lineProgress,
            }}
          />
        ))}
      </svg>
      <div
        className="leaderNode"
        style={{
          opacity: leader,
          transform: `translate(-50%, -50%) scale(${interpolate(leader, [0, 1], [0.78, 1])})`,
        }}
      >
        <span className="crown">Leader</span>
        <strong>依頼を分解</strong>
        <small>TeamHub</small>
      </div>
      <AgentNode label="Programmer" role="実装" x={650} y={405} delay={34} />
      <AgentNode label="Researcher" role="調査" x={635} y={790} delay={44} />
      <AgentNode label="Reviewer" role="レビュー" x={1460} y={365} delay={54} />
      <AgentNode label="Planner" role="計画" x={1495} y={780} delay={64} />
      <div
        className="messageChip"
        style={{
          opacity: appear(local, 88, 20),
          transform: `translateY(${interpolate(appear(local, 88, 20), [0, 1], [20, 0])}px)`,
        }}
      >
        pty に直接注入。待ち時間を作らない。
      </div>
    </AbsoluteFill>
  );
};

const ScreenshotScene = () => {
  const { frame, visible } = useScene(250, 410);
  const p = appear(frame, 262, 34);
  const zoom = interpolate(frame, [250, 410], [1.08, 1.0], clamp);
  const callout = appear(frame, 305, 24);

  return (
    <AbsoluteFill className="scene product" style={{ opacity: visible }}>
      <div className="productFrame" style={{ opacity: p, transform: `scale(${zoom})` }}>
        <Img src={staticFile("screenshot.png")} className="screenshot" />
        <div className="scanLine" style={{ transform: `translateX(${interpolate(frame, [286, 380], [-220, 1380], clamp)}px)` }} />
      </div>
      <div
        className="floatingPanel diff"
        style={{
          opacity: callout,
          transform: `translateY(${interpolate(callout, [0, 1], [36, 0])}px)`,
        }}
      >
        <span>Git diff</span>
        <strong>変更を見て、すぐレビュー依頼</strong>
      </div>
      <div
        className="floatingPanel terminal"
        style={{
          opacity: appear(frame, 330, 24),
          transform: `translateY(${interpolate(appear(frame, 330, 24), [0, 1], [36, 0])}px)`,
        }}
      >
        <span>Terminal grid</span>
        <strong>複数エージェントを並べて監督</strong>
      </div>
    </AbsoluteFill>
  );
};

const FeaturePill = ({ children, delay }: { children: React.ReactNode; delay: number }) => {
  const frame = useCurrentFrame();
  const p = appear(frame, 398 + delay, 22);
  return (
    <div
      className="featurePill"
      style={{
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [28, 0])}px)`,
      }}
    >
      {children}
    </div>
  );
};

const ClosingScene = () => {
  const { frame, visible } = useScene(386, 540);
  const mark = appear(frame, 406, 36);
  const title = appear(frame, 424, 30);
  const finalLine = appear(frame, 472, 26);

  return (
    <AbsoluteFill className="scene closing" style={{ opacity: visible }}>
      <LogoMark progress={mark} compact />
      <div className="closingText" style={{ opacity: title }}>
        <h2>AI 開発を、チームで動かす。</h2>
        <p>レビュー面に残りながら、実装・調査・確認を同時に進めるためのデスクトップ。</p>
      </div>
      <div className="featureRow">
        <FeaturePill delay={0}>TeamHub</FeaturePill>
        <FeaturePill delay={10}>Canvas</FeaturePill>
        <FeaturePill delay={20}>Git diff</FeaturePill>
        <FeaturePill delay={30}>Session resume</FeaturePill>
      </div>
      <div
        className="finalLockup"
        style={{
          opacity: finalLine,
          transform: `translateY(${interpolate(finalLine, [0, 1], [22, 0])}px)`,
        }}
      >
        vibe-editor
      </div>
    </AbsoluteFill>
  );
};

export const VibeEditorPromo = () => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const audioVolume = interpolate(frame, [0, 35, 480, 535], [0, 0.32, 0.3, 0], clamp);

  return (
    <AbsoluteFill className="video">
      <Backdrop />
      <Audio src={staticFile("soundtrack.wav")} volume={audioVolume} />
      <Sequence durationInFrames={160}>
        <HeroScene />
      </Sequence>
      <Sequence from={0} durationInFrames={310}>
        <TeamScene />
      </Sequence>
      <Sequence from={0} durationInFrames={430}>
        <ScreenshotScene />
      </Sequence>
      <ClosingScene />
      <div className="timebar">
        <span style={{ width: `${(frame / (18 * fps)) * 100}%` }} />
      </div>
    </AbsoluteFill>
  );
};
