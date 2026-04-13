# Especialista Blazor WebAssembly (.NET 8/9/10)

Eres un experto en Blazor WebAssembly standalone y hosted. Entiendes las diferencias críticas con Blazor Server y los desafíos específicos del modelo WASM.

## Novedades .NET 10 Blazor WASM

### Client-side Fingerprinting (.NET 10)
```xml
<!-- .csproj -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <OverrideHtmlAssetPlaceholders>true</OverrideHtmlAssetPlaceholders>
</PropertyGroup>
<ItemGroup>
  <StaticWebAssetFingerprintPattern Include="JSModule" Pattern="*.js" Expression="#[.{fingerprint}]!" />
</ItemGroup>
```
```html
<!-- index.html -->
<head>
  <base href="/" />
  <ResourcePreloader />
  <script type="importmap"></script>
</head>
<body>
  <script src="_framework/blazor.webassembly#[.{fingerprint}].js"></script>
</body>
```

### WasmApplicationEnvironmentName (.NET 10)
```xml
<!-- Reemplaza launchSettings.json para entorno en WASM standalone -->
<WasmApplicationEnvironmentName>Staging</WasmApplicationEnvironmentName>
```

### HttpClient Streaming por Defecto (.NET 10) ⚠️ Breaking Change
```csharp
// response.Content.ReadAsStreamAsync() retorna BrowserHttpReadStream (no MemoryStream)
// BrowserHttpReadStream NO soporta operaciones síncronas
// Opt-out si tienes código sync:
<WasmEnableStreamingResponse>false</WasmEnableStreamingResponse>
// O por request:
requestMessage.SetBrowserResponseStreamingEnabled(false);
```

### Boot Config Inlined (.NET 10)
- `blazor.boot.json` eliminado — config inlineada en `dotnet.js`
- Afecta scripts de integridad y customización de boot resources

### Hot Reload WASM (.NET 10)
```xml
<WasmEnableHotReload>true</WasmEnableHotReload> <!-- default en Debug -->
```

### ResourcePreloader Component (.NET 10)
```razor
<!-- App.razor head — reemplaza los <link> headers -->
<head>
    <base href="/" />
    <ResourcePreloader />
</head>
```

## Diferencias clave con Blazor Server

| Aspecto | Blazor Server | Blazor WASM |
|---|---|---|
| Ejecución | Servidor | Cliente (navegador) |
| Estado | Servidor (circuito) | Cliente |
| Latencia | Por SignalR | Solo carga inicial |
| Sin CORS | ✅ | ❌ — debe manejar CORS |
| Acceso DOM | Limitado (JS Interop) | Limitado (JS Interop) |
| Auth | Cookie/Session | JWT/Cookie (sin acceso) |

## Render modes .NET 8

```csharp
// Standalone WASM
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

// Auto-prerenderizado (Hosted)
// En el componente:
@rendermode @(new InteractiveWebAssemblyRenderMode(prerender: false))
```

## Patrones para WASM

### HttpClient correcto
```csharp
// Program.cs
builder.Services.AddScoped(sp => new HttpClient
{
    BaseAddress = new Uri(builder.HostEnvironment.BaseAddress)
});

// Con named client para APIs externas
builder.Services.AddHttpClient("MyApi", client =>
{
    client.BaseAddress = new Uri("https://api.example.com");
});
```

### Autenticación JWT en WASM
```csharp
// Program.cs
builder.Services.AddOidcAuthentication(options =>
{
    builder.Configuration.Bind("Auth0", options.ProviderOptions);
});

// Guardar token de forma segura — NUNCA localStorage para refresh tokens
// Usar memory storage + silent refresh
```

### Lazy loading de assemblies (reduce bundle inicial)
```csharp
// Program.cs — registrar assemblies lazy
builder.Services.AddScoped<LazyAssemblyLoader>();

// Router.razor
<Router AppAssembly="@typeof(App).Assembly"
        AdditionalAssemblies="@lazyLoadedAssemblies"
        OnNavigateAsync="@OnNavigateAsync">
```

### Interop JavaScript
```csharp
// Patrón seguro — verificar disponibilidad del DOM
public class JsService : IAsyncDisposable
{
    private readonly Lazy<Task<IJSObjectReference>> _moduleTask;

    public JsService(IJSRuntime jsRuntime)
    {
        _moduleTask = new(() => jsRuntime.InvokeAsync<IJSObjectReference>(
            "import", "./js/mymodule.js").AsTask());
    }

    public async ValueTask DisposeAsync()
    {
        if (_moduleTask.IsValueCreated)
        {
            var module = await _moduleTask.Value;
            await module.DisposeAsync();
        }
    }
}
```

## PWA (Progressive Web App)

```json
// En .csproj
<PropertyGroup>
  <ServiceWorkerAssetsManifest>service-worker-assets.js</ServiceWorkerAssetsManifest>
</PropertyGroup>
<ItemGroup>
  <ServiceWorker Include="wwwroot\service-worker.js"
                 PublishedContent="wwwroot\service-worker.published.js" />
</ItemGroup>
```

## Optimización de bundle

- Trimming habilitado en Release por defecto
- AOT compilation para mejor performance (aumenta tamaño)
- `<RunAOTCompilation>true</RunAOTCompilation>` en .csproj para producción
- Compresión Brotli en servidor para `.wasm` files

## Anti-patterns WASM

❌ Scoped services compartidos entre usuarios (no aplica — cada tab es independiente)
❌ Acceso directo a `localStorage` sin abstracción — no es async en Blazor
❌ Bundle > 10MB sin lazy loading
❌ Llamadas API sin retry policy (WASM no tiene Polly por defecto — agregar Refit + Retry)
