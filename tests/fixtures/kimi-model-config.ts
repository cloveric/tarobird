export const kimiModelConfig = `default_model = "kimi-code/k3.1-pro"
[thinking]
enabled = true
[providers.managed]
type = "kimi"
api_key = "fixture-secret-never-expose"
[models."kimi-code/k3"]
provider = "managed"
model = "k3"
display_name = "K3"
capabilities = ["thinking", "always_thinking"]
support_efforts = ["low", "high", "max"]
default_effort = "high"
[models."kimi-code/k3.1-pro"]
provider = "managed"
model = "k3.1-pro"
display_name = "K3.1 Pro"
capabilities = ["thinking", "always_thinking"]
support_efforts = ["low", "high", "max"]
default_effort = "max"
[models."kimi-code/kimi-for-coding-highspeed"]
provider = "managed"
model = "kimi-for-coding-highspeed"
display_name = "K2.7 Code Highspeed"
capabilities = ["thinking", "always_thinking"]
`;
