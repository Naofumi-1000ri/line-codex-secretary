import Foundation
import Security

guard CommandLine.arguments.count == 3 else {
  fputs("USAGE: keychain-store <service> <account>\n", stderr)
  exit(2)
}

let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
var password = FileHandle.standardInput.readDataToEndOfFile()
while password.last == 10 || password.last == 13 {
  password.removeLast()
}
guard !password.isEmpty else {
  fputs("EMPTY_PASSWORD\n", stderr)
  exit(2)
}

let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account
]
let update: [String: Any] = [kSecValueData as String: password]
var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
if status == errSecItemNotFound {
  var item = query
  item[kSecValueData as String] = password
  status = SecItemAdd(item as CFDictionary, nil)
}
guard status == errSecSuccess else {
  fputs("KEYCHAIN_WRITE_FAILED:\(status)\n", stderr)
  exit(1)
}
