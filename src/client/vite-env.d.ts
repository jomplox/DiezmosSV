/// <reference types="vite/client" />

// The Givebutter widget registers <givebutter-giving-form> as a custom element
// (loaded from widgets.givebutter.com). Declare it so TSX accepts the tag with its
// campaign attribute. The widget itself reads amount/frequency from the host URL.
// React 19 moved the JSX namespace under the "react" module (the global JSX
// namespace was removed), so the intrinsic element is augmented there.
import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "givebutter-giving-form": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { campaign?: string },
        HTMLElement
      >;
    }
  }
}
