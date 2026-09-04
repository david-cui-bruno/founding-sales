#include <node_api.h>

#include <cerrno>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace {

struct LogDirectory {
  int descriptor = -1;
};

void ThrowErrno(napi_env env, const char* code) {
  std::string message(code);
  message += ": ";
  message += std::strerror(errno);
  napi_throw_error(env, code, message.c_str());
}

bool IsDailyBasename(const std::string& name) {
  if (name.size() != 17 || name.substr(10) != ".ndjson") return false;
  for (size_t index = 0; index < 10; ++index) {
    const char value = name[index];
    if (index == 4 || index == 7) {
      if (value != '-') return false;
    } else if (value < '0' || value > '9') {
      return false;
    }
  }
  return true;
}

bool ReadString(napi_env env, napi_value value, std::string* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::vector<char> buffer(length + 1);
  if (napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length) != napi_ok) {
    return false;
  }
  output->assign(buffer.data(), length);
  return true;
}

LogDirectory* UnwrapThis(napi_env env, napi_callback_info info, size_t argc,
                         napi_value* arguments) {
  napi_value self;
  if (napi_get_cb_info(env, info, &argc, arguments, &self, nullptr) != napi_ok) return nullptr;
  LogDirectory* directory = nullptr;
  if (napi_unwrap(env, self, reinterpret_cast<void**>(&directory)) != napi_ok
      || directory == nullptr || directory->descriptor < 0) {
    napi_throw_error(env, "LOG_DIRECTORY_HANDLE_CLOSED", "Log directory handle is closed.");
    return nullptr;
  }
  return directory;
}

void FinalizeDirectory(napi_env, void* data, void*) {
  auto* directory = static_cast<LogDirectory*>(data);
  if (directory->descriptor >= 0) close(directory->descriptor);
  delete directory;
}

napi_value ListDailyNames(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  LogDirectory* directory = UnwrapThis(env, info, argc, nullptr);
  if (directory == nullptr) return nullptr;
  const int duplicate = openat(
      directory->descriptor, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (duplicate < 0) {
    ThrowErrno(env, "LOG_DIRECTORY_DUP_FAILED");
    return nullptr;
  }
  DIR* stream = fdopendir(duplicate);
  if (stream == nullptr) {
    close(duplicate);
    ThrowErrno(env, "LOG_DIRECTORY_ENUMERATION_FAILED");
    return nullptr;
  }
  std::vector<std::string> names;
  errno = 0;
  while (dirent* entry = readdir(stream)) {
    const std::string name(entry->d_name);
    if (IsDailyBasename(name)) names.push_back(name);
  }
  const int read_error = errno;
  closedir(stream);
  if (read_error != 0) {
    errno = read_error;
    ThrowErrno(env, "LOG_DIRECTORY_ENUMERATION_FAILED");
    return nullptr;
  }
  napi_value result;
  napi_create_array_with_length(env, names.size(), &result);
  for (size_t index = 0; index < names.size(); ++index) {
    napi_value name;
    napi_create_string_utf8(env, names[index].c_str(), names[index].size(), &name);
    napi_set_element(env, result, index, name);
  }
  return result;
}

napi_value OpenDaily(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  size_t argc = 1;
  LogDirectory* directory = UnwrapThis(env, info, argc, arguments);
  if (directory == nullptr) return nullptr;
  std::string name;
  if (argc != 1 || !ReadString(env, arguments[0], &name) || !IsDailyBasename(name)) {
    napi_throw_type_error(env, "LOG_BASENAME_INVALID", "Expected one daily log basename.");
    return nullptr;
  }
  const int descriptor = openat(
      directory->descriptor, name.c_str(),
      O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) {
    ThrowErrno(env, "LOG_FILE_OPEN_FAILED");
    return nullptr;
  }
  napi_value result;
  napi_create_int32(env, descriptor, &result);
  return result;
}

napi_value UnlinkDaily(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  size_t argc = 1;
  LogDirectory* directory = UnwrapThis(env, info, argc, arguments);
  if (directory == nullptr) return nullptr;
  std::string name;
  if (argc != 1 || !ReadString(env, arguments[0], &name) || !IsDailyBasename(name)) {
    napi_throw_type_error(env, "LOG_BASENAME_INVALID", "Expected one daily log basename.");
    return nullptr;
  }
  if (unlinkat(directory->descriptor, name.c_str(), 0) != 0) {
    ThrowErrno(env, "LOG_FILE_UNLINK_FAILED");
    return nullptr;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value CloseDirectory(napi_env env, napi_callback_info info) {
  size_t argc = 0;
  LogDirectory* directory = UnwrapThis(env, info, argc, nullptr);
  if (directory == nullptr) return nullptr;
  if (close(directory->descriptor) != 0) {
    ThrowErrno(env, "LOG_DIRECTORY_CLOSE_FAILED");
    return nullptr;
  }
  directory->descriptor = -1;
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value OpenLogDirectory(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  size_t argc = 1;
  napi_get_cb_info(env, info, &argc, arguments, nullptr, nullptr);
  std::string path;
  if (argc != 1 || !ReadString(env, arguments[0], &path)
      || path.size() < 5 || path.substr(path.size() - 5) != "/logs") {
    napi_throw_type_error(env, "LOG_DIRECTORY_PATH_INVALID", "Expected the application logs path.");
    return nullptr;
  }
  const int descriptor = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) {
    ThrowErrno(env, "LOG_DIRECTORY_OPEN_FAILED");
    return nullptr;
  }
  struct stat metadata {};
  if (fstat(descriptor, &metadata) != 0 || !S_ISDIR(metadata.st_mode)
      || (metadata.st_mode & 0777) != 0700) {
    close(descriptor);
    napi_throw_error(env, "LOG_DIRECTORY_PERMISSIONS_UNSAFE",
                     "Log directory must be a real directory with mode 0700.");
    return nullptr;
  }
  auto* directory = new LogDirectory{descriptor};
  napi_value result;
  napi_create_object(env, &result);
  napi_wrap(env, result, directory, FinalizeDirectory, nullptr, nullptr);
  napi_property_descriptor methods[] = {
      {"listDailyNames", nullptr, ListDailyNames, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"openDaily", nullptr, OpenDaily, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"unlinkDaily", nullptr, UnlinkDaily, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, CloseDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, result, sizeof(methods) / sizeof(methods[0]), methods);
  return result;
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor descriptor = {
      "openLogDirectory", nullptr, OpenLogDirectory, nullptr, nullptr, nullptr, napi_default, nullptr};
  napi_define_properties(env, exports, 1, &descriptor);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
