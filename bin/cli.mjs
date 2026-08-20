#!/usr/bin/env node
import { main } from "../dist/cli.js";
main(process.argv.slice(2))
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    // 예상된 거부(권한·백엔드·네트워크 등)는 스택 없이 메시지만.
    console.error("오류: " + (e?.message ?? e));
    process.exit(1);
  });
