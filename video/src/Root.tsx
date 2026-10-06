import { Composition } from "remotion";
import { PrismDemo } from "./PrismDemo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="PrismDemo"
      component={PrismDemo}
      durationInFrames={30 * 32}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
