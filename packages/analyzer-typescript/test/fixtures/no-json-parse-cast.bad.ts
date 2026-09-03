interface Config {
  name: string;
}
declare const raw: string;
declare const res: { json(): Promise<unknown> };
const cast1 = JSON.parse(raw) as Config;
const cast2 = <Config>JSON.parse(raw);
const cast3: Config = JSON.parse(raw);
function cast4(): Config { return JSON.parse(raw); }
const cast5 = (await res.json()) as Config;
