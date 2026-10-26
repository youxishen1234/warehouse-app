declare module '*.scss' {
  const classes: Record<string, string>;
  export default classes;
}

declare module '*.css' {
  const classes: Record<string, string>;
  export default classes;
}

declare module '*.woff2' {
  const url: string;
  export default url;
}
