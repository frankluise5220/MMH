package com.mmh.app.data.remote.interceptor

import com.mmh.app.data.local.TokenProvider
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject

/**
 * OkHttp interceptor for dynamic server URL and username/password session cookies.
 * No API key header is added.
 */
class AuthInterceptor @Inject constructor(
    private val tokenProvider: TokenProvider
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val baseUrl = tokenProvider.getBaseUrl().toHttpUrlOrNull()
        val requestUrl = if (baseUrl != null) {
            // Retrofit is built with a placeholder baseUrl (http://localhost/),
            // so whatever the user configured only ever reaches OkHttp through
            // this interceptor: scheme, host and port below, plus the server's
            // own sub-path. Gateway-hosted deployments do not serve MMH from
            // their origin root (fnOS publishes it under /app/mmh), so dropping
            // that path here sends every call to "<host>/api/..." where nothing
            // is routed — a blank 404/401 the user cannot diagnose. Join it
            // once, from the single stored representation, so no extra layer has
            // to recognise and repair a bad URL later.
            val serverPrefix = baseUrl.encodedPath.trimEnd('/')
            val endpointPath = original.url.encodedPath
            val finalPath = if (serverPrefix.isEmpty()) endpointPath else "$serverPrefix$endpointPath"
            original.url.newBuilder()
                .scheme(baseUrl.scheme)
                .host(baseUrl.host)
                .port(baseUrl.port)
                .encodedPath(finalPath)
                .build()
        } else {
            original.url
        }
        val sessionCookie = tokenProvider.getSessionCookie()
        val requestBuilder = original.newBuilder().url(requestUrl)
        if (sessionCookie.isNotBlank()) {
            requestBuilder.header("Cookie", sessionCookie)
        }

        val response = chain.proceed(requestBuilder.build())
        val cookies = response.headers("Set-Cookie")
            .mapNotNull { it.substringBefore(';').takeIf(String::isNotBlank) }
        if (cookies.isNotEmpty()) {
            tokenProvider.setSessionCookie(cookies.joinToString("; "))
        }
        return response
    }
}