declare module 'occt-import-js' {
  import type { OcctModule } from '../engine/stepModel'
  const init: (options?: { locateFile?: (path: string) => string }) => Promise<OcctModule>
  export default init
}
