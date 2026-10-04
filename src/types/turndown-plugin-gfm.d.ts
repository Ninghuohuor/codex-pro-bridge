declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  const gfm: {gfm: TurndownService.Plugin};
  export default gfm;
}
