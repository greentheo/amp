// Just enough JSON to read what the browser build writes: chain settings,
// and later the boards and presets it keeps in localStorage.
//
// Numbers go through strtod, which recovers the exact double JSON.stringify
// wrote — it prints the shortest string that round-trips — so a knob at
// 0.55 in the browser is the same double here, not a neighbour of it.

#pragma once
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace ampcore {

struct Json {
    enum Type { Null, Bool, Number, String, Array, Object };
    Type type = Null;
    bool b = false;
    double n = 0;
    std::string s;
    std::vector<Json> a;
    std::vector<std::pair<std::string, Json>> o;  // in document order

    /** A member of an object, or null if it is absent or this is not one. */
    const Json* get(const std::string& key) const {
        if (type != Object) return nullptr;
        for (const auto& kv : o) if (kv.first == key) return &kv.second;
        return nullptr;
    }
    double num(const std::string& key, double dflt) const {
        const Json* v = get(key);
        return v && v->type == Number ? v->n : dflt;
    }
    std::string str(const std::string& key, const std::string& dflt) const {
        const Json* v = get(key);
        return v && v->type == String ? v->s : dflt;
    }
    bool truthy(const std::string& key) const {
        const Json* v = get(key);
        return v && ((v->type == Bool && v->b) || (v->type == Number && v->n != 0));
    }

    static Json parse(const std::string& text) {
        size_t i = 0;
        Json v = value(text, i);
        ws(text, i);
        if (i != text.size()) fail(i, "trailing characters");
        return v;
    }

private:
    [[noreturn]] static void fail(size_t at, const char* what) {
        throw std::runtime_error(std::string("JSON: ") + what + " at offset " + std::to_string(at));
    }
    static void ws(const std::string& t, size_t& i) {
        while (i < t.size() && (t[i] == ' ' || t[i] == '\t' || t[i] == '\n' || t[i] == '\r')) i++;
    }
    static bool lit(const std::string& t, size_t& i, const char* word) {
        const std::string w(word);
        if (t.compare(i, w.size(), w) != 0) return false;
        i += w.size();
        return true;
    }

    static std::string string(const std::string& t, size_t& i) {
        if (t[i] != '"') fail(i, "expected a string");
        std::string out;
        for (i++; i < t.size() && t[i] != '"'; i++) {
            if (t[i] != '\\') { out += t[i]; continue; }
            if (++i >= t.size()) break;
            switch (t[i]) {
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case 'r': out += '\r'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'u': {
                // Basic multilingual plane only, as UTF-8 — enough for names.
                if (i + 4 >= t.size()) fail(i, "short \\u escape");
                const unsigned c = std::stoul(t.substr(i + 1, 4), nullptr, 16);
                i += 4;
                if (c < 0x80) out += char(c);
                else if (c < 0x800) { out += char(0xc0 | c >> 6); out += char(0x80 | (c & 63)); }
                else { out += char(0xe0 | c >> 12); out += char(0x80 | (c >> 6 & 63)); out += char(0x80 | (c & 63)); }
                break;
            }
            default: out += t[i];
            }
        }
        if (i >= t.size()) fail(i, "unterminated string");
        i++;
        return out;
    }

    static Json value(const std::string& t, size_t& i) {
        ws(t, i);
        if (i >= t.size()) fail(i, "unexpected end");
        Json v;
        const char c = t[i];
        if (c == '{') {
            v.type = Object;
            i++;
            ws(t, i);
            if (i < t.size() && t[i] == '}') { i++; return v; }
            for (;;) {
                ws(t, i);
                std::string k = string(t, i);
                ws(t, i);
                if (i >= t.size() || t[i] != ':') fail(i, "expected ':'");
                i++;
                v.o.emplace_back(std::move(k), value(t, i));
                ws(t, i);
                if (i < t.size() && t[i] == ',') { i++; continue; }
                if (i < t.size() && t[i] == '}') { i++; return v; }
                fail(i, "expected ',' or '}'");
            }
        }
        if (c == '[') {
            v.type = Array;
            i++;
            ws(t, i);
            if (i < t.size() && t[i] == ']') { i++; return v; }
            for (;;) {
                v.a.push_back(value(t, i));
                ws(t, i);
                if (i < t.size() && t[i] == ',') { i++; continue; }
                if (i < t.size() && t[i] == ']') { i++; return v; }
                fail(i, "expected ',' or ']'");
            }
        }
        if (c == '"') { v.type = String; v.s = string(t, i); return v; }
        if (lit(t, i, "true")) { v.type = Bool; v.b = true; return v; }
        if (lit(t, i, "false")) { v.type = Bool; return v; }
        if (lit(t, i, "null")) return v;
        const char* start = t.c_str() + i;
        char* end;
        v.n = std::strtod(start, &end);
        if (end == start) fail(i, "unexpected character");
        v.type = Number;
        i += static_cast<size_t>(end - start);
        return v;
    }
};

}  // namespace ampcore
