import assert from "node:assert/strict";

import { toCsv } from "../src/lib/csv";

describe("CSV export", () => {
  it("writes a header line and one line per row, each ended by CRLF", () => {
    const rows = [{ institutionId: "SURMA", netPosition: "1250.50" }];

    assert.equal(toCsv(rows, ["institutionId", "netPosition"]), "institutionId,netPosition\r\nSURMA,1250.50\r\n");
  });

  it("quotes a value that holds a comma, a quote or a line break", () => {
    const rows = [{ name: 'Nakshi "Handicrafts", Dhaka' }, { name: "Line one\nline two" }];

    assert.equal(toCsv(rows, ["name"]), 'name\r\n"Nakshi ""Handicrafts"", Dhaka"\r\n"Line one\nline two"\r\n');
  });

  it("keeps a spreadsheet from running a cell as a formula", () => {
    const rows = ["=1+2", "+8801711000000", "@SUM(A1:A9)", "-2+3"].map((label) => ({ label }));

    assert.equal(toCsv(rows, ["label"]), "label\r\n'=1+2\r\n'+8801711000000\r\n'@SUM(A1:A9)\r\n'-2+3\r\n");
  });

  it("leaves numbers as they are, negative positions included", () => {
    const rows = [{ netPosition: "-1500.00" }, { netPosition: "0" }, { netPosition: 42n }];

    assert.equal(toCsv(rows, ["netPosition"]), "netPosition\r\n-1500.00\r\n0\r\n42\r\n");
  });

  it("writes an empty cell for a missing value", () => {
    const rows = [
      { id: "SANGU", district: null },
      { id: "HALDA", district: undefined },
    ];

    assert.equal(toCsv(rows, ["id", "district"]), "id,district\r\nSANGU,\r\nHALDA,\r\n");
  });
});
