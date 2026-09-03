// The file that owns the type the bad fixture augments from outside. It exists so
// the fixture demonstrates the actual defect: a reader who opens this file to
// learn the shape of DispatchOpened finds an answer that is missing three fields.

export interface DispatchLiveness {
  readonly supervisor: string;
  readonly openedAt: number;
  readonly heartbeatAt: number;
}

export interface DispatchOpened {
  readonly id: string;
  readonly lane: string;
}
