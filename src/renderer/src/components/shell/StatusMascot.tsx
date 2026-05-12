import { memo, useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { StatusMascotVariant } from '../../../../types/shared';
import type { StatusMascotState } from '../../lib/status-mascot';
import { isTauri } from '../../lib/tauri-api';

interface StatusMascotProps {
  state: StatusMascotState;
  label: string;
  variant?: StatusMascotVariant;
  /**
   * variant === 'custom' のとき表示するユーザー画像の絶対パス。
   * convertFileSrc() で asset URL に変換して <img> で描画する。
   */
  customPath?: string;
}

export const StatusMascot = memo(function StatusMascot({
  state,
  label,
  variant = 'vibe',
  customPath
}: StatusMascotProps): JSX.Element {
  return (
    <span
      className={`status-mascot status-mascot--${state} status-mascot--variant-${variant}`}
      role="img"
      aria-label={label}
      title={label}
      data-state={state}
      data-variant={variant}
    >
      <span className="status-mascot__motion" aria-hidden="true">
        <span className="status-mascot__viewport">
          {variant === 'custom' ? (
            <CustomMascotImage customPath={customPath} label={label} />
          ) : (
            <svg
              className="status-mascot__sheet"
              viewBox="0 0 96 16"
              width="96"
              height="16"
              focusable="false"
              shapeRendering="crispEdges"
            >
              <MascotFrame x={0} variant={variant} typing="left" />
              <MascotFrame x={16} variant={variant} tool="pencil" arm="up" typing="right" />
              <MascotFrame x={32} variant={variant} tool="paper" sparkle typing="both" />
              <MascotFrame
                x={48}
                variant={variant}
                arm="run"
                legs="run"
                sparkle
                typing="right"
              />
              <MascotFrame x={64} variant={variant} tool="lens" arm="up" typing="left" />
              <MascotFrame x={80} variant={variant} alert legs="flat" typing="both" />
            </svg>
          )}
        </span>
      </span>
    </span>
  );
});

interface CustomMascotImageProps {
  customPath?: string;
  label: string;
}

/**
 * ユーザー画像 (variant='custom') を `asset://` 経由で <img> 描画する。
 * 失敗時 / dev:vite 時 / 未指定時は組み込み SVG のプレースホルダにフォールバック。
 */
function CustomMascotImage({ customPath, label }: CustomMascotImageProps): JSX.Element {
  const tauri = isTauri();
  const [errored, setErrored] = useState(false);
  const src = useMemo(() => {
    if (!tauri || !customPath) return '';
    try {
      return convertFileSrc(customPath);
    } catch {
      return '';
    }
  }, [tauri, customPath]);
  // 壊れた画像で onError 後に customPath を別画像へ差し替えても、errored=true のままだと
  // <img> がマウントされず placeholder にロックされる。path 切替時にリセットする。
  useEffect(() => {
    setErrored(false);
  }, [customPath]);

  if (!src || errored) {
    return <CustomMascotPlaceholder />;
  }

  return (
    <img
      className="status-mascot__custom-img"
      src={src}
      alt={label}
      draggable={false}
      onError={() => setErrored(true)}
    />
  );
}

function CustomMascotPlaceholder(): JSX.Element {
  return (
    <svg
      className="status-mascot__sheet status-mascot__sheet--placeholder"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      focusable="false"
      shapeRendering="crispEdges"
    >
      <rect className="status-mascot__body" x="4" y="4" width="8" height="8" />
      <rect className="status-mascot__eye" x="6" y="7" width="1" height="1" />
      <rect className="status-mascot__eye" x="9" y="7" width="1" height="1" />
    </svg>
  );
}

type Tool = 'pencil' | 'paper' | 'lens';

interface MascotFrameProps {
  x: number;
  variant: StatusMascotVariant;
  tool?: Tool;
  arm?: 'up' | 'run';
  legs?: 'run' | 'flat';
  typing?: 'left' | 'right' | 'both';
  sparkle?: boolean;
  alert?: boolean;
}

function MascotFrame({
  x,
  variant,
  tool,
  arm,
  legs,
  typing,
  sparkle,
  alert
}: MascotFrameProps): JSX.Element {
  const bodyClass = alert
    ? 'status-mascot__body status-mascot__body--alert'
    : 'status-mascot__body';

  if (variant === 'coder') {
    return (
      <CoderMascotFrame
        x={x}
        bodyClass={bodyClass}
        typing={typing}
        sparkle={sparkle}
        alert={alert}
        reviewing={tool === 'lens'}
      />
    );
  }

  return (
    <g transform={`translate(${x} 0)`}>
      <rect className="status-mascot__shadow" x="4" y="14" width="9" height="1" />
      {sparkle ? (
        <>
          <rect className="status-mascot__spark" x="13" y="2" width="1" height="1" />
          <rect className="status-mascot__spark" x="14" y="3" width="1" height="1" />
          <rect className="status-mascot__spark" x="12" y="3" width="1" height="1" />
        </>
      ) : null}

      {variant === 'mono' ? (
        <>
          <rect className={bodyClass} x="4" y="3" width="9" height="8" />
          <rect className="status-mascot__panel" x="5" y="4" width="7" height="4" />
          <rect className="status-mascot__body-shade" x="5" y="9" width="7" height="1" />
          <rect className="status-mascot__antenna" x="8" y="1" width="1" height="2" />
          <rect className="status-mascot__antenna" x="7" y="0" width="3" height="1" />
        </>
      ) : variant === 'spark' ? (
        <>
          <rect className="status-mascot__antenna" x="8" y="1" width="1" height="1" />
          <rect className={bodyClass} x="7" y="2" width="3" height="1" />
          <rect className={bodyClass} x="5" y="3" width="7" height="1" />
          <rect className={bodyClass} x="4" y="4" width="9" height="1" />
          <rect className={bodyClass} x="3" y="5" width="11" height="2" />
          <rect className={bodyClass} x="4" y="7" width="9" height="1" />
          <rect className={bodyClass} x="5" y="8" width="7" height="1" />
          <rect className={bodyClass} x="6" y="9" width="5" height="1" />
          <rect className={bodyClass} x="7" y="10" width="3" height="1" />
          <rect className="status-mascot__body-shade" x="5" y="8" width="7" height="1" />
        </>
      ) : (
        <>
          <rect className={bodyClass} x="7" y="3" width="3" height="1" />
          <rect className={bodyClass} x="6" y="4" width="5" height="1" />
          <rect className={bodyClass} x="5" y="5" width="7" height="1" />
          <rect className={bodyClass} x="4" y="6" width="9" height="1" />
          <rect className={bodyClass} x="5" y="7" width="7" height="1" />
          <rect className={bodyClass} x="6" y="8" width="5" height="2" />
          <rect className={bodyClass} x="7" y="10" width="3" height="1" />
          <rect className="status-mascot__body-shade" x="6" y="9" width="5" height="1" />
        </>
      )}

      {tool === 'lens' ? (
        <>
          <rect className="status-mascot__review" x="6" y="5" width="2" height="1" />
          <rect className="status-mascot__review" x="9" y="5" width="2" height="1" />
          <rect className="status-mascot__eye" x="8" y="6" width="1" height="1" />
          <rect className="status-mascot__eye" x="11" y="7" width="1" height="1" />
        </>
      ) : variant === 'mono' ? (
        <>
          <rect className="status-mascot__eye" x="6" y="5" width="1" height="1" />
          <rect className="status-mascot__eye" x="10" y="5" width="1" height="1" />
          <rect className="status-mascot__shine" x="7" y="7" width="3" height="1" />
        </>
      ) : variant === 'spark' ? (
        <>
          <rect className="status-mascot__eye" x="6" y="5" width="2" height="1" />
          <rect className="status-mascot__eye" x="10" y="5" width="2" height="1" />
          <rect className="status-mascot__shine" x="8" y="7" width="2" height="1" />
        </>
      ) : (
        <>
          <rect className="status-mascot__eye" x="7" y="5" width="3" height="1" />
          <rect className="status-mascot__shine" x="11" y="6" width="1" height="1" />
        </>
      )}

      <rect
        className={bodyClass}
        x={arm === 'up' ? 3 : 4}
        y={arm === 'run' ? 8 : 7}
        width="1"
        height="2"
      />
      <rect
        className={bodyClass}
        x={arm === 'run' ? 13 : 12}
        y={arm === 'up' ? 5 : 7}
        width="1"
        height="2"
      />

      {legs === 'flat' ? (
        <>
          <rect className={bodyClass} x="5" y="11" width="3" height="1" />
          <rect className={bodyClass} x="9" y="11" width="3" height="1" />
        </>
      ) : (
        <>
          <rect className={bodyClass} x="6" y="11" width="1" height={legs === 'run' ? 2 : 3} />
          <rect className={bodyClass} x="10" y="11" width="1" height={legs === 'run' ? 3 : 2} />
        </>
      )}

      {tool === 'pencil' ? (
        <>
          <rect className="status-mascot__tool" x="13" y="4" width="1" height="4" />
          <rect className="status-mascot__tool-tip" x="13" y="3" width="1" height="1" />
        </>
      ) : null}
      {tool === 'paper' ? (
        <>
          <rect className="status-mascot__paper" x="1" y="4" width="3" height="4" />
          <rect className="status-mascot__paper-line" x="3" y="4" width="1" height="1" />
          <rect className="status-mascot__paper-line" x="2" y="6" width="1" height="1" />
        </>
      ) : null}
      {alert ? (
        <>
          <rect className="status-mascot__alert" x="13" y="3" width="1" height="4" />
          <rect className="status-mascot__alert" x="13" y="8" width="1" height="1" />
        </>
      ) : null}
    </g>
  );
}

interface CoderMascotFrameProps {
  x: number;
  bodyClass: string;
  typing?: 'left' | 'right' | 'both';
  sparkle?: boolean;
  alert?: boolean;
  reviewing?: boolean;
}

function CoderMascotFrame({
  x,
  bodyClass,
  typing,
  sparkle,
  alert,
  reviewing
}: CoderMascotFrameProps): JSX.Element {
  const leftHandY = typing === 'left' || typing === 'both' ? 10 : 9;
  const rightHandY = typing === 'right' || typing === 'both' ? 10 : 9;

  return (
    <g transform={`translate(${x} 0)`}>
      <rect className="status-mascot__shadow" x="2" y="14" width="12" height="1" />
      {sparkle ? (
        <>
          <rect className="status-mascot__spark" x="14" y="2" width="1" height="1" />
          <rect className="status-mascot__spark" x="13" y="3" width="1" height="1" />
          <rect className="status-mascot__spark" x="15" y="3" width="1" height="1" />
        </>
      ) : null}

      <rect className="status-mascot__screen" x="1" y="4" width="7" height="5" />
      <rect className="status-mascot__screen-glow" x="2" y="5" width="5" height="3" />
      {reviewing ? (
        <>
          <rect className="status-mascot__review" x="3" y="6" width="1" height="1" />
          <rect className="status-mascot__review" x="5" y="6" width="1" height="1" />
        </>
      ) : (
        <>
          <rect className="status-mascot__screen-line" x="3" y="5" width="3" height="1" />
          <rect className="status-mascot__screen-line" x="2" y="7" width="4" height="1" />
        </>
      )}
      <rect className="status-mascot__keyboard" x="1" y="10" width="8" height="2" />
      <rect className="status-mascot__key" x="2" y="10" width="1" height="1" />
      <rect className="status-mascot__key" x="4" y="10" width="1" height="1" />
      <rect className="status-mascot__key" x="6" y="10" width="1" height="1" />

      <rect className={bodyClass} x="9" y="4" width="5" height="6" />
      <rect className={bodyClass} x="8" y="6" width="1" height="2" />
      <rect className={bodyClass} x="14" y="6" width="1" height="2" />
      <rect className="status-mascot__body-shade" x="10" y="9" width="4" height="1" />
      <rect className="status-mascot__eye" x="10" y="6" width="1" height="1" />
      <rect className="status-mascot__eye" x="13" y="6" width="1" height="1" />
      {alert ? (
        <>
          <rect className="status-mascot__alert" x="15" y="4" width="1" height="4" />
          <rect className="status-mascot__alert" x="15" y="9" width="1" height="1" />
        </>
      ) : (
        <rect className="status-mascot__shine" x="11" y="8" width="2" height="1" />
      )}

      <rect
        className="status-mascot__hand status-mascot__hand--left"
        x="8"
        y={leftHandY}
        width="1"
        height="1"
      />
      <rect
        className="status-mascot__hand status-mascot__hand--right"
        x="12"
        y={rightHandY}
        width="1"
        height="1"
      />
      <rect className={bodyClass} x="10" y="10" width="1" height="2" />
      <rect className={bodyClass} x="13" y="10" width="1" height="2" />
    </g>
  );
}
