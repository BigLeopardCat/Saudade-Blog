import { useEffect, useImperativeHandle, useMemo, useRef, forwardRef } from 'react';
import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';

export interface Live2dAgentHandle {
  setMouthOpen: (open: boolean) => void;
  setMouthValue: (value: number) => void;
}

const Live2dAgent = forwardRef<Live2dAgentHandle>((_, ref) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ mouthTarget: 0, mouthValue: 0 });

  useImperativeHandle(ref, () => ({
    setMouthOpen(open: boolean) {
      stateRef.current.mouthTarget = open ? 1 : 0;
    },
    setMouthValue(value: number) {
      stateRef.current.mouthTarget = Math.max(0, Math.min(1, value));
    },
  }), []);

  const appOptions = useMemo(
    () => ({
      width: 260,
      height: 360,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoStart: true,
    }),
    []
  );

  useEffect(() => {
    const baseUrl = import.meta.env.BASE_URL || '/';
    const resolveAssetUrl = (path: string) => {
      if (/^https?:\/\//i.test(baseUrl)) {
        return new URL(path, baseUrl).toString();
      }
      return new URL(path, `${window.location.origin}${baseUrl}`).toString();
    };
    const modelUrl = resolveAssetUrl('Live2d_agent/agent_2.model3.json');

    (window as typeof window & { PIXI?: typeof PIXI }).PIXI = PIXI;
    const container = containerRef.current;
    if (!container) return;

    const app = new PIXI.Application(appOptions);
    container.appendChild(app.view as HTMLCanvasElement);

    let cancelled = false;

    const loadModel = async () => {
      try {
        const model = await Live2DModel.from(modelUrl);
        if (cancelled) {
          model.destroy();
          return;
        }

        model.x = 130;
        model.y = 220;
        model.scale.set(0.16, 0.16);
        model.anchor.set(0.5, 0.5);
        app.stage.addChild(model);

        app.ticker.add(() => {
          const s = stateRef.current;
          const diff = s.mouthTarget - s.mouthValue;
          s.mouthValue += diff * 0.13;
          model.internalModel?.setParameterValueById?.('ParamMouthOpenY', s.mouthValue * 0.8);
          model.internalModel?.setParameterValueById?.('ParamSpeak', s.mouthValue);
          model.internalModel?.setParameterValueById?.('ParamTail', Math.sin(performance.now() / 700) * 20);
          model.internalModel?.setParameterValueById?.('ParamDaiMao', Math.sin(performance.now() / 1000) * 8);
          model.internalModel?.setParameterValueById?.('ParamHairFront', Math.sin(performance.now() / 1200 + 1) * 6);
          model.internalModel?.setParameterValueById?.('Param3', Math.sin(performance.now() / 600 + 1.3) * 6);
          model.internalModel?.setParameterValueById?.('ParamEyeLOpen', 1 - Math.abs(Math.sin(performance.now() / 900)) * 0.08);
          model.internalModel?.setParameterValueById?.('ParamEyeROpen', 1 - Math.abs(Math.sin(performance.now() / 900)) * 0.08);
        });
      } catch (error) {
        console.error('Live2D model load failed', error);
      }
    };

    void loadModel();

    return () => {
      cancelled = true;
      app.ticker.stop();
      app.destroy(true, { children: true });
    };
  }, [appOptions]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        right: 12,
        bottom: 12,
        zIndex: 1000,
        width: 260,
        height: 360,
        pointerEvents: 'none',
      }}
    />
  );
});

Live2dAgent.displayName = 'Live2dAgent';

export default Live2dAgent;
