import { Composition } from "remotion";
import { VibeEditorPromo } from "./VibeEditorPromo";

export const RemotionRoot = () => {
  return (
    <Composition
      id="VibeEditorPromo"
      component={VibeEditorPromo}
      durationInFrames={540}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
