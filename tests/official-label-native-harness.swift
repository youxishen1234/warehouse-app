import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), message)
}

let valid = URL(string: "https://youxishen.online/#/pages/label-resolver/index?v=1&kind=finished-product&id=7")!
check(valid.scheme == "https" && valid.host == "youxishen.online", "canonical host")
check(valid.path == "/", "root path")
let fragment = valid.fragment ?? ""
check(fragment.hasPrefix("/pages/label-resolver/index?"), "resolver fragment")
let query = String(fragment.split(separator: "?", maxSplits: 1)[1])
let items = query.split(separator: "&").map { $0.split(separator: "=", maxSplits: 1) }
check(items.count == 3 && items.allSatisfy { $0.count == 2 }, "exact query fields")
check(items.contains { $0[0] == "v" && $0[1] == "1" }, "version")
check(items.contains { $0[0] == "kind" && $0[1] == "finished-product" }, "kind")
check(items.contains { $0[0] == "id" && $0[1] == "7" }, "id")

let media = ["widthMm": 50.0, "heightMm": 30.0, "density": 3.0, "printerName": "K3-TEST"]
let signature = media.keys.sorted().map { "\($0)=\(media[$0]!)" }.joined(separator: "|")
check(signature.contains("widthMm=50.0") && signature.contains("heightMm=30.0"), "media fingerprint inputs")
print("official label Foundation harness passed")
