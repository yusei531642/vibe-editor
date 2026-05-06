import { memo } from 'react';
import type { StatusMascotVariant } from '../../../../types/shared';
import type { StatusMascotState } from '../../lib/status-mascot';

interface StatusMascotProps {
  state: StatusMascotState;
  label: string;
  variant?: StatusMascotVariant;
}

export const StatusMascot = memo(function StatusMascot({
  state,
  label,
  variant = 'vibe'
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
          <svg
            className="status-mascot__sheet"
            viewBox="0 0 96 16"
            width="96"
            height="16"
            focusable="false"
            shapeRendering="crispEdges"
          >
            <MascotFrame x={0} variant={variant} />
            <MascotFrame x={16} variant={variant} tool="pencil" arm="up" />
            <MascotFrame x={32} variant={variant} tool="paper" sparkle />
            <MascotFrame x={48} variant={variant} arm="run" legs="run" sparkle />
            <MascotFrame x={64} variant={variant} tool="lens" arm="up" />
            <MascotFrame x={80} variant={variant} alert legs="flat" />
          </svg>
        </span>
      </span>
    </span>
  );
});

type Tool = 'pencil' | 'paper' | 'lens';

interface MascotFrameProps {
  x: number;
  variant: StatusMascotVariant;
  tool?: Tool;
  arm?: 'up' | 'run';
  legs?: 'run' | 'flat';
  sparkle?: boolean;
  alert?: boolean;
}

function MascotFrame({
  x,
  variant,
  tool,
  arm,
  legs,
  sparkle,
  alert
}: MascotFrameProps): JSX.Element {
  const bodyClass = alert
    ? 'status-mascot__body status-mascot__body--alert'
    : 'status-mascot__body';

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
