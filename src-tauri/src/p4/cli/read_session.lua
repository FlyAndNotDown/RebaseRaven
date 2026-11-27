-- Runs inside the selected p4 executable. Only read operations have a wire representation.
local p = P4.P4:new()
local function setting(name)
    local value = os.getenv("RR_P4_" .. name)
    return value ~= "" and value or nil
end
p.port = assert(setting("PORT"))
p.client = assert(setting("CLIENT"))
p.user = assert(setting("USER"))
if setting("CHARSET") then p.charset = setting("CHARSET") end
p.exception_level = 0

local function send(row)
    io.write(cjson.encode(row), "\n")
end
local function records(key, ...)
    p:reset()
    local result = p:run(...)
    assert(#p.errors == 0 and #p.warnings == 0)
    for _, row in ipairs(result) do
        for _, value in pairs(row) do
            -- Array-valued tags vary across API versions. Let the CLI preserve their indices.
            assert(type(value) == "string")
        end
        send({[key] = row})
    end
end
local function read(request)
    if request == "pending" then
        records("pending", "changes", "-s", "pending", "-c", p.client, "-L")
        records("shelved", "changes", "-s", "shelved", "-c", p.client, "-L")
        records("opened", "opened")
        p:reset()
        local spec = p:run("change", "-o")
        send({description = spec[1] and spec[1].Description or ""})
    elseif type(request) == "table" and request.fstat then
        records("file", "fstat", "-T", request.fstat.fields, table.unpack(request.fstat.paths))
    else
        error("Unsupported read")
    end
end

assert(p:connect())
send({settings = {p.ticket_file, p.trust_file, p.p4config_file or "", p.enviro_file or ""}})
io.flush()
for line in io.lines() do
    local ok = pcall(read, cjson.decode(line))
    send(ok and "done" or "failed")
    io.flush()
    if not ok then break end
end
p:disconnect()
